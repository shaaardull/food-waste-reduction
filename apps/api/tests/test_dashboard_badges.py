"""Contract test for the sidebar-badge counter endpoint.

Ensures the staff dashboard can poll a single lightweight endpoint
for all three actionable counters (live orders, validation queue,
open disputes) rather than triangulating them from the heavier
per-view endpoints.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from tests.conftest import (
    login,
    make_restaurant,
    make_staff,
    make_table_code,
    register_diner,
)


def _seed_session(db, restaurant_id, diner_id, status: str):
    """Attach one meal session in the given status to the diner +
    restaurant. Table code follows the RUN_TAG pattern so the
    conftest teardown catches it."""
    from app.models.meal_session import MealSession

    started = datetime.now(UTC) - timedelta(minutes=10)
    s = MealSession(
        diner_user_id=diner_id,
        restaurant_id=restaurant_id,
        table_code=make_table_code("badge"),
        status=status,
        started_at=started,
        expires_at=started + timedelta(hours=4),
    )
    db.add(s)
    db.flush()
    return s


@pytest.mark.asyncio
async def test_badges_counts_sum_to_actionable_queue(client, db):
    """Seed one session per actionable state and one non-actionable
    (rewarded — historical). Assert the badge endpoint returns exactly
    the counts we seeded — nothing more, nothing less."""
    from app.models.dispute import Dispute
    from app.models.user import User as UserModel

    restaurant, _, _ = make_restaurant(db, name="Badge Counts")
    staff = make_staff(db, restaurant.id)
    # A throwaway diner to hang sessions off — real signup would be
    # overkill for a counter test.
    diner_user, _ = await register_diner(client, label="badge-diner")
    diner_id = __import__("uuid").UUID(diner_user["id"])

    # 3 active orders (open, before_captured, eating).
    _seed_session(db, restaurant.id, diner_id, "open")
    _seed_session(db, restaurant.id, diner_id, "before_captured")
    _seed_session(db, restaurant.id, diner_id, "eating")
    # 2 pending validations.
    v1 = _seed_session(db, restaurant.id, diner_id, "pending_staff_validation")
    _seed_session(db, restaurant.id, diner_id, "pending_staff_validation")
    # 1 rewarded — should NOT be counted anywhere.
    reward_session = _seed_session(db, restaurant.id, diner_id, "rewarded")
    # 1 open dispute + 1 resolved dispute.
    disputer = db.get(UserModel, diner_id)
    db.add(
        Dispute(
            meal_session_id=v1.id,
            raised_by_user_id=disputer.id,
            reason="staff decision looks off",
            status="open",
        )
    )
    db.add(
        Dispute(
            meal_session_id=reward_session.id,
            raised_by_user_id=disputer.id,
            reason="already resolved sample",
            status="closed",
        )
    )
    db.commit()

    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/badges",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["orders_active"] == 3
    assert body["validations_pending"] == 2
    assert body["disputes_open"] == 1


@pytest.mark.asyncio
async def test_badges_zero_when_nothing_actionable(client, db):
    """Empty state — new restaurant with no sessions. All three
    counters should return 0 (not null, not missing) so the client
    can render an unbadged nav cleanly."""
    restaurant, _, _ = make_restaurant(db, name="Badge Zeros")
    staff = make_staff(db, restaurant.id)
    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/badges",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body == {
        "orders_active": 0,
        "validations_pending": 0,
        "disputes_open": 0,
        "rewards_issued_today": 0,
    }


@pytest.mark.asyncio
async def test_badges_forbids_non_staff(client, db):
    """A diner (or a staff at a DIFFERENT restaurant) must not be
    able to read another restaurant's queue depth."""
    restaurant, _, _ = make_restaurant(db, name="Badge Auth")
    _, diner_token = await register_diner(client, label="badge-nonstaff")
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/badges",
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert res.status_code in (403, 404)
