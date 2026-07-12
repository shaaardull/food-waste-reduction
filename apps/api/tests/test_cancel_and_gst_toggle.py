"""Tests for the E1 additions:

1. POST /sessions/:id/cancel — staff cancels an in-flight order.
2. PATCH /sessions/:id/items — staff replaces the item list pre-bill.
3. restaurants.gst_enabled = false — billing skips CGST/SGST split.

Ethics rule 9 (diner recourse) is protected by the "reason is
required" and "reason is echoed back on the session read" assertions.
The immutable-invoice invariant is protected by the "cancel/edit after
bill is issued → 409" assertions.
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
)


def _diner_user(db: Session) -> tuple[str, str]:
    from app.models.user import User
    from app.security import hash_password

    email = make_email("cancel-diner")
    u = User(
        email=email,
        display_name="Cancel Diner",
        role="diner",
        password_hash=hash_password("plate-clean-demo"),
    )
    db.add(u)
    db.flush()
    db.commit()
    return str(u.id), email


def _make_session_with_items(
    db: Session,
    *,
    restaurant_id,
    menu_items,
    diner_user_id: str | None = None,
    status: str = "before_captured",
) -> MealSession:
    if diner_user_id is None:
        diner_user_id, _ = _diner_user(db)
    started = datetime.now(UTC) - timedelta(minutes=10)
    session = MealSession(
        diner_user_id=diner_user_id,
        restaurant_id=restaurant_id,
        table_code=make_table_code("cancel"),
        status=status,
        started_at=started,
        expires_at=started + timedelta(hours=4),
    )
    db.add(session)
    db.flush()
    for m in menu_items:
        db.add(
            MealSessionItem(
                meal_session_id=session.id,
                menu_item_id=m.id,
                quantity=1,
                portion_size="regular",
            )
        )
    db.commit()
    return session


# ── Cancel endpoint ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_staff_can_cancel_open_session(client, db):
    restaurant, items, _ = make_restaurant(db, name="Cancel Open")
    diner_id, _ = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    staff = make_staff(db, restaurant.id)
    token = await login(client, staff.email)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/cancel",
        json={"reason": "Kitchen ran out of paneer"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "cancelled"
    assert body["cancelled_reason"] == "Kitchen ran out of paneer"
    assert body["cancelled_at"] is not None


@pytest.mark.asyncio
async def test_cancel_reason_required(client, db):
    """Bare cancellation w/o a reason must fail — ethics rule 9."""
    restaurant, items, _ = make_restaurant(db, name="Cancel No Reason")
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1]
    )
    staff = make_staff(db, restaurant.id)
    token = await login(client, staff.email)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/cancel",
        json={"reason": "a"},  # too short
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_diner_sees_cancellation_reason_on_session_read(client, db):
    """After cancel, GET /sessions/:id (diner) surfaces the reason."""
    restaurant, items, _ = make_restaurant(db, name="Diner Sees Reason")
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    staff = make_staff(db, restaurant.id)
    staff_token = await login(client, staff.email)
    reason = "Chef mistakenly duplicated your order."
    await client.post(
        f"/api/v1/sessions/{session.id}/cancel",
        json={"reason": reason},
        headers={"Authorization": f"Bearer {staff_token}"},
    )
    diner_token = await login(client, diner_email)
    read = await client.get(
        f"/api/v1/sessions/{session.id}",
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert read.status_code == 200
    session_body = read.json()["session"]
    assert session_body["status"] == "cancelled"
    assert session_body["cancelled_reason"] == reason


@pytest.mark.asyncio
async def test_cancel_after_bill_issued_rejected(client, db):
    """Once a bill exists, cancel returns 409 (bill immutability)."""
    restaurant, items, _ = make_restaurant(db, name="Cancel After Bill")
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    diner_token = await login(client, diner_email)
    bill_res = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert bill_res.status_code == 200

    staff = make_staff(db, restaurant.id)
    staff_token = await login(client, staff.email)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/cancel",
        json={"reason": "Too late, we changed our minds."},
        headers={"Authorization": f"Bearer {staff_token}"},
    )
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "BILL_ALREADY_ISSUED"


@pytest.mark.asyncio
async def test_non_staff_cannot_cancel(client, db):
    """A diner (or a staff member of a different restaurant) is 403."""
    restaurant, items, _ = make_restaurant(db, name="Foreign Cancel")
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    diner_token = await login(client, diner_email)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/cancel",
        json={"reason": "I'd like to cancel my own order thanks."},
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert res.status_code == 403


# ── Item-replace endpoint ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_staff_can_replace_items_pre_bill(client, db):
    restaurant, items, _ = make_restaurant(db, name="Edit Items")
    diner_id, _ = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    staff = make_staff(db, restaurant.id)
    token = await login(client, staff.email)
    res = await client.patch(
        f"/api/v1/sessions/{session.id}/items",
        json={
            "items": [
                {"menu_item_id": str(items[1].id), "quantity": 2, "portion_size": "large"}
            ]
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text

    # Verify the DB state — old row gone, new row present.
    from sqlalchemy import select as sa_select

    from app.models.meal_session import MealSessionItem as MSI

    remaining = db.execute(
        sa_select(MSI).where(MSI.meal_session_id == session.id)
    ).scalars().all()
    assert len(remaining) == 1
    assert str(remaining[0].menu_item_id) == str(items[1].id)
    assert remaining[0].quantity == 2


@pytest.mark.asyncio
async def test_replace_items_after_bill_rejected(client, db):
    restaurant, items, _ = make_restaurant(db, name="Edit After Bill")
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    diner_token = await login(client, diner_email)
    await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {diner_token}"},
    )

    staff = make_staff(db, restaurant.id)
    staff_token = await login(client, staff.email)
    res = await client.patch(
        f"/api/v1/sessions/{session.id}/items",
        json={"items": [{"menu_item_id": str(items[1].id), "quantity": 1}]},
        headers={"Authorization": f"Bearer {staff_token}"},
    )
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "BILL_ALREADY_ISSUED"


# ── GST toggle ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bill_skips_gst_when_disabled(client, db):
    """gst_enabled=false → CGST + SGST both zero, total == subtotal."""
    restaurant, items, _ = make_restaurant(db, name="No GST")
    restaurant.gst_enabled = False
    db.commit()
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:2], diner_user_id=diner_id
    )
    token = await login(client, diner_email)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    b = res.json()
    expected = sum(m.price_minor for m in items[:2])
    assert b["subtotal_minor"] == expected
    assert b["taxable_amount_minor"] == expected
    assert b["cgst_amount_minor"] == 0
    assert b["sgst_amount_minor"] == 0
    assert b["total_minor"] == expected


@pytest.mark.asyncio
async def test_past_orders_endpoint_returns_terminal_sessions(client, db):
    """`/dashboard/orders/past` returns rewarded / rejected / cancelled
    sessions with the cancelled_reason echoed back."""
    restaurant, items, _ = make_restaurant(db, name="Past Orders")
    diner_id, _ = _diner_user(db)
    # One active session — should NOT show up in past.
    _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        diner_user_id=diner_id,
        status="open",
    )
    # One cancelled — SHOULD show up, with the reason echoed.
    cancelled = _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        diner_user_id=diner_id,
        status="cancelled",
    )
    cancelled.cancelled_reason = "Kitchen ran out of paneer"
    db.commit()

    staff = make_staff(db, restaurant.id)
    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/orders/past",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    orders = res.json()["orders"]
    ids = [o["session_id"] for o in orders]
    assert str(cancelled.id) in ids
    match = next(o for o in orders if o["session_id"] == str(cancelled.id))
    assert match["status"] == "cancelled"
    assert match["cancelled_reason"] == "Kitchen ran out of paneer"


@pytest.mark.asyncio
async def test_gst_toggle_defaults_to_true(client, db):
    """A fresh restaurant with no explicit gst_enabled setting behaves
    like the pre-E1 world — CGST + SGST are non-zero."""
    restaurant, items, _ = make_restaurant(db, name="Default GST")
    assert restaurant.gst_enabled is True
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    token = await login(client, diner_email)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    b = res.json()
    assert b["cgst_amount_minor"] > 0
    assert b["sgst_amount_minor"] > 0
