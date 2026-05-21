"""Integration tests for GET /restaurants/:id/dashboard/staff-metrics."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from app.models.restaurant import RestaurantStaff
from app.models.staff_metrics import StaffMetricsSnapshot
from app.models.user import User
from app.security import hash_password
from tests.conftest import (
    login,
    make_email,
    make_restaurant,
    register_diner,
)


def _make_staff(db: Session, restaurant_id, *, label: str = "staff") -> User:
    u = User(
        email=make_email(label),
        display_name=f"Test {label}",
        role="staff",
        password_hash=hash_password("plate-clean-demo"),
    )
    db.add(u)
    db.flush()
    db.add(RestaurantStaff(user_id=u.id, restaurant_id=restaurant_id, role="server"))
    db.commit()
    return u


def _snapshot(
    db: Session,
    *,
    staff_id,
    restaurant_id,
    period_start: datetime,
    validations: int,
    rejections: int,
    median: Decimal,
) -> None:
    """Build a StaffMetricsSnapshot directly so we don't have to fake
    28 days of validation history per test."""
    approvals = max(0, validations - rejections)
    rejection_rate = (
        Decimal(rejections) / Decimal(validations) if validations else Decimal(0)
    )
    approval_rate = (
        Decimal(approvals) / Decimal(validations) if validations else Decimal(0)
    )
    db.add(
        StaffMetricsSnapshot(
            staff_user_id=staff_id,
            restaurant_id=restaurant_id,
            period_start=period_start,
            period_end=period_start + timedelta(days=7),
            validations_count=validations,
            approvals_count=approvals,
            rejections_count=rejections,
            adjustments_count=0,
            rejection_rate=rejection_rate,
            approval_rate=approval_rate,
            restaurant_median_rejection_rate=median,
        )
    )
    db.flush()


@pytest.mark.asyncio
async def test_staff_metrics_endpoint_groups_by_staff(client, db):
    restaurant, _, _ = make_restaurant(db, name="SM Group")
    staff_a = _make_staff(db, restaurant.id, label="sm_a")
    staff_b = _make_staff(db, restaurant.id, label="sm_b")
    base = datetime(2026, 4, 27, 0, 0, tzinfo=UTC)
    for w in range(2):
        period = base + timedelta(weeks=w)
        _snapshot(
            db,
            staff_id=staff_a.id,
            restaurant_id=restaurant.id,
            period_start=period,
            validations=20,
            rejections=4,
            median=Decimal("0.2"),
        )
        _snapshot(
            db,
            staff_id=staff_b.id,
            restaurant_id=restaurant.id,
            period_start=period,
            validations=10,
            rejections=1,
            median=Decimal("0.2"),
        )
    db.commit()

    token = await login(client, staff_a.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/staff-metrics?weeks=4",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    # Two staff each with 2 snapshots, most-recent first.
    by_email = {row["email"]: row for row in body}
    assert staff_a.email in by_email
    assert staff_b.email in by_email
    assert len(by_email[staff_a.email]["snapshots"]) == 2
    # Newest period first.
    snaps = by_email[staff_a.email]["snapshots"]
    assert snaps[0]["period_start"] > snaps[1]["period_start"]


@pytest.mark.asyncio
async def test_staff_metrics_flags_over_threshold(client, db):
    restaurant, _, _ = make_restaurant(db, name="SM Threshold")
    bad = _make_staff(db, restaurant.id, label="sm_bad")
    good = _make_staff(db, restaurant.id, label="sm_good")

    # Median 0.2, alert threshold = 2× = 0.4.
    _snapshot(
        db,
        staff_id=bad.id,
        restaurant_id=restaurant.id,
        period_start=datetime(2026, 5, 4, 0, 0, tzinfo=UTC),
        validations=20,
        rejections=12,  # 0.6 > 0.4
        median=Decimal("0.2"),
    )
    _snapshot(
        db,
        staff_id=good.id,
        restaurant_id=restaurant.id,
        period_start=datetime(2026, 5, 4, 0, 0, tzinfo=UTC),
        validations=20,
        rejections=2,  # 0.1
        median=Decimal("0.2"),
    )
    db.commit()

    token = await login(client, good.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/staff-metrics",
        headers={"Authorization": f"Bearer {token}"},
    )
    body = res.json()
    by_email = {row["email"]: row for row in body}
    assert by_email[bad.email]["snapshots"][0]["over_threshold"] is True
    assert by_email[good.email]["snapshots"][0]["over_threshold"] is False


@pytest.mark.asyncio
async def test_staff_metrics_endpoint_rejects_non_staff(client, db):
    restaurant, _, _ = make_restaurant(db, name="SM Forbid")
    _, token = await register_diner(client, label="smdiner")
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/staff-metrics",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_staff_metrics_below_min_validations_not_flagged(client, db):
    restaurant, _, _ = make_restaurant(db, name="SM Min")
    staff = _make_staff(db, restaurant.id, label="sm_min")
    # rejection_rate 0.5, > 2× median 0.1 = 0.2, but only 3 validations
    # — under MIN_VALIDATIONS_FOR_ALERT, so over_threshold stays False.
    _snapshot(
        db,
        staff_id=staff.id,
        restaurant_id=restaurant.id,
        period_start=datetime(2026, 5, 4, 0, 0, tzinfo=UTC),
        validations=3,
        rejections=2,
        median=Decimal("0.1"),
    )
    db.commit()
    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/staff-metrics",
        headers={"Authorization": f"Bearer {token}"},
    )
    body = res.json()
    snap = body[0]["snapshots"][0]
    assert snap["over_threshold"] is False
