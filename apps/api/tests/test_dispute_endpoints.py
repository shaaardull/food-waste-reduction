"""Integration tests for the dispute detail + resolve endpoints (§5.5 + §8 rule 9)."""
from __future__ import annotations

import pytest
from sqlalchemy.orm import Session

from app.models.dispute import Dispute
from app.models.meal_session import MealSession
from app.models.restaurant import RestaurantStaff
from app.models.user import User
from app.security import hash_password
from tests.conftest import (
    login,
    make_email,
    make_restaurant,
    make_table_code,
    register_diner,
)


def _make_user(db: Session, *, role: str = "staff", label: str = "u") -> User:
    u = User(
        email=make_email(label),
        display_name=f"Test {label}",
        role=role,
        password_hash=hash_password("plate-clean-demo"),
    )
    db.add(u)
    db.flush()
    return u


def _make_owner(db: Session, restaurant_id) -> User:
    u = _make_user(db, role="staff", label="owner")
    db.add(RestaurantStaff(user_id=u.id, restaurant_id=restaurant_id, role="owner"))
    db.commit()
    return u


def _make_manager(db: Session, restaurant_id) -> User:
    u = _make_user(db, role="staff", label="manager")
    db.add(RestaurantStaff(user_id=u.id, restaurant_id=restaurant_id, role="manager"))
    db.commit()
    return u


def _seed_dispute(db: Session, restaurant_id, diner_id) -> Dispute:
    from datetime import UTC, datetime, timedelta

    session = MealSession(
        diner_user_id=diner_id,
        restaurant_id=restaurant_id,
        table_code=make_table_code("disp"),
        status="disputed",
        started_at=datetime.now(UTC),
        expires_at=datetime.now(UTC) + timedelta(hours=4),
    )
    db.add(session)
    db.flush()
    dispute = Dispute(
        meal_session_id=session.id,
        raised_by_user_id=diner_id,
        reason="The server rejected me but I cleared the plate.",
        status="open",
    )
    db.add(dispute)
    db.commit()
    db.refresh(dispute)
    return dispute


@pytest.mark.asyncio
async def test_dispute_detail_for_owner(client, db):
    restaurant, _, _ = make_restaurant(db, name="Disp Detail")
    owner = _make_owner(db, restaurant.id)
    diner_payload, _ = await register_diner(client, label="dispdetail")
    import uuid as _uuid

    dispute = _seed_dispute(db, restaurant.id, _uuid.UUID(diner_payload["id"]))

    token = await login(client, owner.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/disputes/{dispute.id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["dispute"]["status"] == "open"
    assert body["dispute"]["reason"].startswith("The server rejected")
    assert body["diner"]["email"] == diner_payload["email"]


@pytest.mark.asyncio
async def test_dispute_detail_404_cross_restaurant(client, db):
    """A dispute that belongs to restaurant A should return 404 when queried
    via restaurant B's URL — no info leakage."""
    rest_a, _, _ = make_restaurant(db, name="Disp A")
    rest_b, _, _ = make_restaurant(db, name="Disp B")
    owner_b = _make_owner(db, rest_b.id)
    diner_payload, _ = await register_diner(client, label="dispcross")
    import uuid as _uuid

    dispute_at_a = _seed_dispute(db, rest_a.id, _uuid.UUID(diner_payload["id"]))

    token = await login(client, owner_b.email)
    res = await client.get(
        f"/api/v1/restaurants/{rest_b.id}/dashboard/disputes/{dispute_at_a.id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_resolve_requires_owner(client, db):
    restaurant, _, _ = make_restaurant(db, name="Disp Owner")
    manager = _make_manager(db, restaurant.id)
    diner_payload, _ = await register_diner(client, label="resolveowner")
    import uuid as _uuid

    dispute = _seed_dispute(db, restaurant.id, _uuid.UUID(diner_payload["id"]))

    token = await login(client, manager.email)
    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/disputes/{dispute.id}/resolve",
        json={"status": "closed", "resolution_notes": "no decision needed"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_resolve_happy_path(client, db):
    restaurant, _, _ = make_restaurant(db, name="Disp Happy")
    owner = _make_owner(db, restaurant.id)
    diner_payload, _ = await register_diner(client, label="resolvehappy")
    import uuid as _uuid

    dispute = _seed_dispute(db, restaurant.id, _uuid.UUID(diner_payload["id"]))

    token = await login(client, owner.email)
    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/disputes/{dispute.id}/resolve",
        json={
            "status": "resolved_in_favor_diner",
            "resolution_notes": "Plate matched the after-photo on review.",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "resolved_in_favor_diner"
    assert body["resolution_notes"].startswith("Plate matched")


@pytest.mark.asyncio
async def test_resolve_idempotent_same_decision(client, db):
    restaurant, _, _ = make_restaurant(db, name="Disp Idem")
    owner = _make_owner(db, restaurant.id)
    diner_payload, _ = await register_diner(client, label="resolveidem")
    import uuid as _uuid

    dispute = _seed_dispute(db, restaurant.id, _uuid.UUID(diner_payload["id"]))

    token = await login(client, owner.email)
    first = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/disputes/{dispute.id}/resolve",
        json={"status": "closed"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert first.status_code == 200
    second = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/disputes/{dispute.id}/resolve",
        json={"status": "closed"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert second.status_code == 200
    assert second.json()["status"] == "closed"


@pytest.mark.asyncio
async def test_resolve_conflicting_decision_returns_409(client, db):
    restaurant, _, _ = make_restaurant(db, name="Disp Conflict")
    owner = _make_owner(db, restaurant.id)
    diner_payload, _ = await register_diner(client, label="resolveconflict")
    import uuid as _uuid

    dispute = _seed_dispute(db, restaurant.id, _uuid.UUID(diner_payload["id"]))

    token = await login(client, owner.email)
    first = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/disputes/{dispute.id}/resolve",
        json={"status": "resolved_in_favor_diner"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert first.status_code == 200
    second = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/disputes/{dispute.id}/resolve",
        json={"status": "resolved_in_favor_restaurant"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert second.status_code == 409
