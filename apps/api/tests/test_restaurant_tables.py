"""Tests for the self-serve restaurant_tables surface.

Coverage:
  • GET returns rows for a restaurant, ordered by display_order.
  • Create with omitted table_code auto-assigns the next sequential
    T-NN.
  • Create with an existing active code returns 409 TABLE_CODE_EXISTS.
  • Create with auto_generate_qr=true binds a fresh qr_token in
    'assigned' state.
  • Create with auto_generate_qr=false leaves qr_token_id NULL.
  • PATCH renaming table_code retires the old qr_token binding and
    nulls qr_token_id.
  • DELETE soft-deletes + retires bound qr_token; historical
    meal_sessions with that table_code still queryable.
  • regenerate-qr issues a fresh token and retires the old one.
  • Server role → 403 NOT_RESTAURANT_STAFF; owner/manager → 200.
  • Cross-restaurant staff → 403 NOT_RESTAURANT_STAFF (matches
    task_e990fddf envelope shape).
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.orm import Session

from app.models.meal_session import MealSession
from app.models.qr_token import QRToken
from app.models.restaurant import RestaurantStaff
from app.models.restaurant_table import RestaurantTable
from app.models.user import User
from app.security import hash_password
from tests.conftest import (
    login,
    make_email,
    make_restaurant,
    make_staff,
    register_diner,
)


def _make_owner(db: Session, restaurant_id) -> User:
    u = User(
        email=make_email("owner"),
        display_name="Test Owner",
        role="staff",
        password_hash=hash_password("plate-clean-demo"),
    )
    db.add(u)
    db.flush()
    db.add(RestaurantStaff(user_id=u.id, restaurant_id=restaurant_id, role="owner"))
    db.commit()
    return u


def _make_server(db: Session, restaurant_id) -> User:
    u = User(
        email=make_email("server"),
        display_name="Test Server",
        role="staff",
        password_hash=hash_password("plate-clean-demo"),
    )
    db.add(u)
    db.flush()
    db.add(RestaurantStaff(user_id=u.id, restaurant_id=restaurant_id, role="server"))
    db.commit()
    return u


def _seed_tables(db: Session, restaurant_id, count: int = 3) -> list[RestaurantTable]:
    """Insert `count` active rows T-01..T-0N. Tests that need the DB
    to already contain tables (rather than going through the POST
    endpoint) use this."""
    made: list[RestaurantTable] = []
    for i in range(1, count + 1):
        row = RestaurantTable(
            restaurant_id=restaurant_id,
            table_code=f"T-{i:02d}",
            seat_count=4,
            is_active=True,
            display_order=i,
        )
        db.add(row)
        made.append(row)
    db.commit()
    for r in made:
        db.refresh(r)
    return made


# ── GET list ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_returns_seeded_rows_ordered(client, db):
    restaurant, _, _ = make_restaurant(db, name="List Rows")
    _seed_tables(db, restaurant.id, count=3)
    owner = _make_owner(db, restaurant.id)
    token = await login(client, owner.email)

    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    codes = [row["table_code"] for row in body]
    assert codes == ["T-01", "T-02", "T-03"]
    for row in body:
        assert row["is_active"] is True
        assert row["qr_token"] is None


@pytest.mark.asyncio
async def test_list_include_inactive(client, db):
    restaurant, _, _ = make_restaurant(db, name="List Inactive")
    _seed_tables(db, restaurant.id, count=2)
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)

    # Soft delete T-01 via DELETE endpoint.
    ids_res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        headers={"Authorization": f"Bearer {token}"},
    )
    t01_id = next(r["id"] for r in ids_res.json() if r["table_code"] == "T-01")
    del_res = await client.delete(
        f"/api/v1/restaurants/{restaurant.id}/tables/{t01_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert del_res.status_code == 204

    # Without include_inactive: only T-02.
    active_only = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert [r["table_code"] for r in active_only.json()] == ["T-02"]

    # With include_inactive: both.
    all_rows = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/tables?include_inactive=true",
        headers={"Authorization": f"Bearer {token}"},
    )
    codes = sorted(r["table_code"] for r in all_rows.json())
    assert codes == ["T-01", "T-02"]


# ── POST create ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_auto_assigns_next_sequential_code(client, db):
    restaurant, _, _ = make_restaurant(db, name="Auto Code")
    _seed_tables(db, restaurant.id, count=3)  # T-01..T-03
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)

    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        json={"seat_count": 6, "auto_generate_qr": False},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["table_code"] == "T-04"
    assert body["seat_count"] == 6
    assert body["qr_token"] is None


@pytest.mark.asyncio
async def test_create_duplicate_active_code_returns_409(client, db):
    restaurant, _, _ = make_restaurant(db, name="Dup Code")
    _seed_tables(db, restaurant.id, count=2)
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)

    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        json={"table_code": "T-01", "auto_generate_qr": False},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 409
    body = res.json()
    assert body["error"]["code"] == "TABLE_CODE_EXISTS"


@pytest.mark.asyncio
async def test_create_with_auto_qr_binds_fresh_token(client, db):
    restaurant, _, _ = make_restaurant(db, name="Auto QR")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)

    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        json={"table_code": "T-42", "auto_generate_qr": True},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["table_code"] == "T-42"
    assert body["qr_token"] is not None
    assert body["qr_token"]["state"] == "assigned"
    assert len(body["qr_token"]["token"]) == 10

    # Verify a qr_tokens row is bound to the table code.
    fresh_token_str = body["qr_token"]["token"]
    row = (
        db.query(QRToken).filter(QRToken.token == fresh_token_str).one()
    )
    assert row.state == "assigned"
    assert row.table_code == "T-42"
    assert row.restaurant_id == restaurant.id
    assert row.batch_label == "self-serve"


@pytest.mark.asyncio
async def test_create_without_auto_qr_leaves_null(client, db):
    restaurant, _, _ = make_restaurant(db, name="No QR")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)

    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        json={"table_code": "T-99", "auto_generate_qr": False},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 201, res.text
    assert res.json()["qr_token"] is None


# ── PATCH ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_patch_rename_retires_bound_token(client, db):
    restaurant, _, _ = make_restaurant(db, name="Rename Retire")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)

    created = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        json={"table_code": "T-05", "auto_generate_qr": True},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert created.status_code == 201
    table_id = created.json()["id"]
    old_token_str = created.json()["qr_token"]["token"]

    renamed = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}/tables/{table_id}",
        json={"table_code": "T-55"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert renamed.status_code == 200, renamed.text
    body = renamed.json()
    assert body["table_code"] == "T-55"
    # Bound QR gets nulled on rename — owner is nudged to regenerate.
    assert body["qr_token"] is None

    # The prior qr_tokens row got retired.
    old_row = db.query(QRToken).filter(QRToken.token == old_token_str).one()
    assert old_row.state == "retired"
    assert old_row.table_code is None


@pytest.mark.asyncio
async def test_patch_seat_count_and_notes(client, db):
    restaurant, _, _ = make_restaurant(db, name="Patch Fields")
    _seed_tables(db, restaurant.id, count=1)
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    listing = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        headers={"Authorization": f"Bearer {token}"},
    )
    tid = listing.json()[0]["id"]

    res = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}/tables/{tid}",
        json={"seat_count": 8, "notes": "Window bay"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["seat_count"] == 8
    assert body["notes"] == "Window bay"


@pytest.mark.asyncio
async def test_patch_restore_soft_deleted(client, db):
    restaurant, _, _ = make_restaurant(db, name="Restore")
    _seed_tables(db, restaurant.id, count=1)
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    listing = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        headers={"Authorization": f"Bearer {token}"},
    )
    tid = listing.json()[0]["id"]

    await client.delete(
        f"/api/v1/restaurants/{restaurant.id}/tables/{tid}",
        headers={"Authorization": f"Bearer {token}"},
    )
    restored = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}/tables/{tid}",
        json={"is_active": True},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert restored.status_code == 200
    assert restored.json()["is_active"] is True


# ── DELETE (soft) ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_soft_removes_and_retires_qr(client, db):
    restaurant, _, _ = make_restaurant(db, name="Del Retires")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)

    created = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        json={"table_code": "T-77", "auto_generate_qr": True},
        headers={"Authorization": f"Bearer {token}"},
    )
    tid = created.json()["id"]
    qr_str = created.json()["qr_token"]["token"]

    # Simulate a historical (walk-in, paid, no diner) meal_session at
    # that code before delete — walk-ins allow NULL diner_user_id.
    now = datetime.now(UTC)
    hist = MealSession(
        diner_user_id=None,
        restaurant_id=restaurant.id,
        table_code="T-77",
        status="paid",
        entry_channel="walkin",
        started_at=now,
        expires_at=now + timedelta(hours=4),
    )
    db.add(hist)
    db.commit()

    del_res = await client.delete(
        f"/api/v1/restaurants/{restaurant.id}/tables/{tid}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert del_res.status_code == 204

    # QR retired.
    qr_row = db.query(QRToken).filter(QRToken.token == qr_str).one()
    assert qr_row.state == "retired"

    # Historical meal_session still queryable at the same code.
    survived = (
        db.query(MealSession)
        .filter(
            MealSession.restaurant_id == restaurant.id,
            MealSession.table_code == "T-77",
        )
        .all()
    )
    assert len(survived) == 1


# ── regenerate-qr ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_regenerate_qr_retires_old_and_binds_fresh(client, db):
    restaurant, _, _ = make_restaurant(db, name="Regen")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)

    created = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        json={"table_code": "T-30", "auto_generate_qr": True},
        headers={"Authorization": f"Bearer {token}"},
    )
    tid = created.json()["id"]
    old_qr_str = created.json()["qr_token"]["token"]

    regen = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/tables/{tid}/regenerate-qr",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert regen.status_code == 200, regen.text
    new_qr_str = regen.json()["qr_token"]["token"]
    assert new_qr_str != old_qr_str
    assert regen.json()["qr_token"]["state"] == "assigned"

    old_row = db.query(QRToken).filter(QRToken.token == old_qr_str).one()
    assert old_row.state == "retired"
    new_row = db.query(QRToken).filter(QRToken.token == new_qr_str).one()
    assert new_row.state == "assigned"
    assert new_row.table_code == "T-30"


# ── Auth guards ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_owner_can_list(client, db):
    restaurant, _, _ = make_restaurant(db, name="Owner OK")
    _seed_tables(db, restaurant.id, count=1)
    owner = _make_owner(db, restaurant.id)
    token = await login(client, owner.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200


@pytest.mark.asyncio
async def test_manager_can_list(client, db):
    restaurant, _, _ = make_restaurant(db, name="Manager OK")
    _seed_tables(db, restaurant.id, count=1)
    manager = make_staff(db, restaurant.id)  # manager
    token = await login(client, manager.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200


@pytest.mark.asyncio
async def test_server_forbidden(client, db):
    restaurant, _, _ = make_restaurant(db, name="Server Blocked")
    server = _make_server(db, restaurant.id)
    token = await login(client, server.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "NOT_RESTAURANT_STAFF"


@pytest.mark.asyncio
async def test_cross_restaurant_staff_forbidden(client, db):
    r_a, _, _ = make_restaurant(db, name="Cross A")
    r_b, _, _ = make_restaurant(db, name="Cross B")
    # Manager exists only on B's roster.
    staff_b = make_staff(db, r_b.id)
    token = await login(client, staff_b.email)
    res = await client.get(
        f"/api/v1/restaurants/{r_a.id}/tables",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "NOT_RESTAURANT_STAFF"


@pytest.mark.asyncio
async def test_diner_forbidden(client, db):
    restaurant, _, _ = make_restaurant(db, name="Diner Blocked")
    _, diner_token = await register_diner(client, label="tables-diner")
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/tables",
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "NOT_RESTAURANT_STAFF"
