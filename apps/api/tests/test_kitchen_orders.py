"""Tests for the Live Orders dashboard endpoints.

  GET  /restaurants/:id/dashboard/orders   — kanban feed
  POST /sessions/:id/kitchen-ack           — cosmetic "mark sent"

Live Orders is the piece that turns the app's lightweight menu from
"data-collection for the vision model" into "the kitchen actually
sees the order." Endpoints are staff-only (any role) per the sprint
kickoff.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.orm import Session

from app.models.meal_session import MealSession, MealSessionItem
from tests.conftest import (
    login,
    make_email,
    make_restaurant,
    make_staff,
    make_table_code,
    register_diner,
)


def _diner_row(db: Session) -> str:
    from app.models.user import User
    from app.security import hash_password

    u = User(
        email=make_email("diner-row"),
        display_name="Table diner",
        role="diner",
        password_hash=hash_password("plate-clean-demo"),
    )
    db.add(u)
    db.flush()
    return str(u.id)


def _make_session_with_items(
    db: Session,
    *,
    restaurant_id,
    menu_items,
    status: str = "open",
    kitchen_ack_at=None,
    started_ago_seconds: int = 30,
) -> MealSession:
    """Create a meal session at `restaurant` with `menu_items` in it.
    Returns the persisted session with items already flushed."""
    diner_id = _diner_row(db)
    started = datetime.now(UTC) - timedelta(seconds=started_ago_seconds)
    session = MealSession(
        diner_user_id=diner_id,
        restaurant_id=restaurant_id,
        table_code=make_table_code("live"),
        status=status,
        started_at=started,
        expires_at=started + timedelta(hours=4),
        kitchen_ack_at=kitchen_ack_at,
    )
    db.add(session)
    db.flush()
    for m in menu_items:
        db.add(
            MealSessionItem(
                meal_session_id=session.id,
                menu_item_id=m.id,
                quantity=1,
                portion_size="small",
            )
        )
    db.commit()
    return session


# ── GET /dashboard/orders ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_orders_lists_only_active_statuses(client, db):
    """A `rewarded` session is done — it must not show on the live board."""
    restaurant, items, _ = make_restaurant(db, name="Orders Only Active")
    _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        status="open",
    )
    _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        status="rewarded",
    )
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/orders",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert len(body["orders"]) == 1
    assert body["orders"][0]["status"] == "open"


@pytest.mark.asyncio
async def test_orders_hides_open_sessions_without_items(client, db):
    """`open` + no items = a diner who scanned but hasn't ordered.
    The kitchen has nothing to see; drop from the board."""
    restaurant, _, _ = make_restaurant(db, name="Orders No Items")
    _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=[],
        status="open",
    )
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/orders",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    assert res.json()["orders"] == []


@pytest.mark.asyncio
async def test_orders_includes_all_four_column_states(client, db):
    """The response must carry enough info for the frontend to slot
    each row into one of NEW / PREPARING / EATING / READY-TO-CLAIM."""
    restaurant, items, _ = make_restaurant(db, name="Orders Kanban")
    _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        status="open",
    )
    _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        status="open",
        kitchen_ack_at=datetime.now(UTC),
    )
    _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        status="before_captured",
    )
    _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        status="pending_staff_validation",
    )
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/orders",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    rows = res.json()["orders"]
    assert {r["status"] for r in rows} == {
        "open",
        "before_captured",
        "pending_staff_validation",
    }
    # Split the two 'open' rows by kitchen_ack_at.
    opens = [r for r in rows if r["status"] == "open"]
    assert {bool(r["kitchen_ack_at"]) for r in opens} == {False, True}


@pytest.mark.asyncio
async def test_orders_sorts_oldest_first(client, db):
    restaurant, items, _ = make_restaurant(db, name="Orders Sort")
    _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        status="open",
        started_ago_seconds=10,
    )
    _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        status="open",
        started_ago_seconds=500,
    )
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/orders",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    rows = res.json()["orders"]
    assert rows[0]["started_seconds_ago"] > rows[1]["started_seconds_ago"]


@pytest.mark.asyncio
async def test_orders_diner_blocked(client, db):
    restaurant, _, _ = make_restaurant(db, name="Orders Diner Blocked")
    _, diner_token = await register_diner(client)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/orders",
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert res.status_code == 403


# ── POST /sessions/:id/kitchen-ack ────────────────────────────────────


@pytest.mark.asyncio
async def test_kitchen_ack_sets_timestamp(client, db):
    restaurant, items, _ = make_restaurant(db, name="Ack Sets")
    session = _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        status="open",
    )
    assert session.kitchen_ack_at is None
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/kitchen-ack",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["session_id"] == str(session.id)
    assert body["kitchen_ack_at"] is not None
    # Row updated.
    db.expire_all()
    reloaded = db.get(MealSession, session.id)
    assert reloaded is not None
    assert reloaded.kitchen_ack_at is not None


@pytest.mark.asyncio
async def test_kitchen_ack_is_idempotent(client, db):
    """Second call must return 200 with the ORIGINAL timestamp — the
    cosmetic ack should never move around under repeated taps."""
    restaurant, items, _ = make_restaurant(db, name="Ack Idempotent")
    session = _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        status="open",
    )
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    first = await client.post(
        f"/api/v1/sessions/{session.id}/kitchen-ack",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert first.status_code == 200
    ts_first = first.json()["kitchen_ack_at"]
    second = await client.post(
        f"/api/v1/sessions/{session.id}/kitchen-ack",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert second.status_code == 200
    assert second.json()["kitchen_ack_at"] == ts_first


@pytest.mark.asyncio
async def test_kitchen_ack_cross_restaurant_blocked(client, db):
    """Staff of restaurant B cannot ack an order at restaurant A."""
    r_a, items_a, _ = make_restaurant(db, name="Ack Cross A")
    r_b, _, _ = make_restaurant(db, name="Ack Cross B")
    session_at_a = _make_session_with_items(
        db,
        restaurant_id=r_a.id,
        menu_items=items_a[:1],
        status="open",
    )
    staff_b = make_staff(db, r_b.id)
    token = await login(client, staff_b.email)
    res = await client.post(
        f"/api/v1/sessions/{session_at_a.id}/kitchen-ack",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_kitchen_ack_diner_blocked(client, db):
    restaurant, items, _ = make_restaurant(db, name="Ack Diner")
    session = _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        status="open",
    )
    _, diner_token = await register_diner(client)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/kitchen-ack",
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_kitchen_ack_404_for_missing_session(client, db):
    from uuid import uuid4

    restaurant, _, _ = make_restaurant(db, name="Ack Missing")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    res = await client.post(
        f"/api/v1/sessions/{uuid4()}/kitchen-ack",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 404
