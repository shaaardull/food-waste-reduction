"""Integration tests for GET /restaurants/:id/dashboard/analytics-overview.

Covers the five-widget analytics screen aggregations: revenue trend,
peak-hours heatmap, top items, avg ticket + prior-period delta, and
new-vs-repeat diner ratio. All widgets share one range in the request.
"""
from __future__ import annotations

import uuid as _uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy.orm import Session

from app.models.bill import Bill
from app.models.meal_session import MealSession, MealSessionItem
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


def _make_staff(db: Session, restaurant_id, *, label: str = "ao_staff") -> User:
    u = User(
        email=make_email(label),
        display_name=f"Test {label}",
        role="staff",
        password_hash=hash_password("plate-clean-demo"),
    )
    db.add(u)
    db.flush()
    db.add(RestaurantStaff(user_id=u.id, restaurant_id=restaurant_id, role="manager"))
    db.commit()
    return u


def _seed_billed_session(
    db: Session,
    *,
    restaurant_id,
    diner_user_id,
    menu_item_id,
    when: datetime,
    total_minor: int,
    quantity: int = 1,
    voided: bool = False,
) -> tuple[MealSession, Bill]:
    """Create a session + bill + one item at a specific point in time.

    `when` is used for BOTH `session.started_at` and `bill.created_at`
    so the range filter can be exercised deterministically. If `voided`
    is true, `session.voided_at` is set so the row falls out of the
    revenue / avg-ticket / top-items aggregations.
    """
    session = MealSession(
        diner_user_id=diner_user_id,
        restaurant_id=restaurant_id,
        table_code=make_table_code("ao"),
        status="voided" if voided else "billed",
        entry_channel="qr" if diner_user_id else "walkin",
        started_at=when,
        expires_at=when + timedelta(hours=4),
        voided_at=when if voided else None,
    )
    db.add(session)
    db.flush()
    db.add(
        MealSessionItem(
            meal_session_id=session.id,
            menu_item_id=menu_item_id,
            quantity=quantity,
        )
    )
    bill = Bill(
        meal_session_id=session.id,
        restaurant_id=restaurant_id,
        bill_number=f"AO-{_uuid.uuid4().hex[:6]}",
        subtotal_minor=total_minor,
        discount_minor=0,
        taxable_amount_minor=total_minor,
        cgst_rate=Decimal("0.000"),
        sgst_rate=Decimal("0.000"),
        cgst_amount_minor=0,
        sgst_amount_minor=0,
        total_minor=total_minor,
        currency="INR",
        line_items_json=[],
        delivery_status="pending",
        issued_at=when,
        created_at=when,
        updated_at=when,
    )
    db.add(bill)
    db.commit()
    db.refresh(session)
    db.refresh(bill)
    return session, bill


@pytest.mark.asyncio
async def test_range_7d_bounds(client, db):
    """`7d` = now-7 → now, and label reflects the choice."""
    restaurant, _, _ = make_restaurant(db, name="AO 7d")
    staff = _make_staff(db, restaurant.id, label="ao_7d")
    token = await login(client, staff.email)
    before = datetime.now(UTC)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/analytics-overview?range=7d",
        headers={"Authorization": f"Bearer {token}"},
    )
    after = datetime.now(UTC)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["range"]["label"] == "Last 7 days"
    from_dt = datetime.fromisoformat(body["range"]["from"])
    to_dt = datetime.fromisoformat(body["range"]["to"])
    # `to` should be within the window bracketing this call.
    assert before <= to_dt <= after
    # `from` should sit exactly seven days before `to`.
    delta = to_dt - from_dt
    assert timedelta(days=6, hours=23) <= delta <= timedelta(days=7, hours=1)


@pytest.mark.asyncio
async def test_revenue_total_and_daily(client, db):
    """Sum of bill.total_minor matches revenue.total_minor; per-day
    bucket carries the right number for the bucket a bill landed on."""
    restaurant, items, _ = make_restaurant(db, name="AO Rev")
    main, _ = items
    diner_payload, _ = await register_diner(client, label="ao_rev_diner")
    diner_id = _uuid.UUID(diner_payload["id"])
    staff = _make_staff(db, restaurant.id, label="ao_rev_staff")

    now = datetime.now(UTC)
    _seed_billed_session(
        db,
        restaurant_id=restaurant.id,
        diner_user_id=diner_id,
        menu_item_id=main.id,
        when=now - timedelta(days=1, hours=2),
        total_minor=50000,
    )
    _seed_billed_session(
        db,
        restaurant_id=restaurant.id,
        diner_user_id=diner_id,
        menu_item_id=main.id,
        when=now - timedelta(days=1, hours=1),
        total_minor=25000,
    )
    # A voided bill inside the window — must NOT count.
    _seed_billed_session(
        db,
        restaurant_id=restaurant.id,
        diner_user_id=diner_id,
        menu_item_id=main.id,
        when=now - timedelta(days=1),
        total_minor=99999,
        voided=True,
    )
    # A bill outside the 7-day window — must NOT count.
    _seed_billed_session(
        db,
        restaurant_id=restaurant.id,
        diner_user_id=diner_id,
        menu_item_id=main.id,
        when=now - timedelta(days=20),
        total_minor=99999,
    )

    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/analytics-overview?range=7d",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["revenue"]["total_minor"] == 75000
    # The two counted bills fell on the same local day (yesterday-ish).
    tz = ZoneInfo(restaurant.timezone)
    expected_day = (now - timedelta(days=1)).astimezone(tz).strftime("%Y-%m-%d")
    day_totals = {d["date"]: d["total_minor"] for d in body["revenue"]["daily"]}
    assert day_totals[expected_day] == 75000


@pytest.mark.asyncio
async def test_delta_pct_null_when_prior_zero(client, db):
    """Prior period has no bills → delta_pct is null (avoids /0)."""
    restaurant, items, _ = make_restaurant(db, name="AO Delta0")
    main, _ = items
    diner_payload, _ = await register_diner(client, label="ao_d0_diner")
    diner_id = _uuid.UUID(diner_payload["id"])
    staff = _make_staff(db, restaurant.id, label="ao_d0_staff")

    now = datetime.now(UTC)
    _seed_billed_session(
        db,
        restaurant_id=restaurant.id,
        diner_user_id=diner_id,
        menu_item_id=main.id,
        when=now - timedelta(hours=2),
        total_minor=40000,
    )

    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/analytics-overview?range=7d",
        headers={"Authorization": f"Bearer {token}"},
    )
    body = res.json()
    assert body["revenue"]["prior_period_total_minor"] == 0
    assert body["revenue"]["delta_pct"] is None
    assert body["avg_ticket"]["prior_period_minor"] == 0
    assert body["avg_ticket"]["delta_pct"] is None


@pytest.mark.asyncio
async def test_delta_pct_with_prior_data(client, db):
    """When both windows have data, delta_pct = (cur - prior) / prior * 100."""
    restaurant, items, _ = make_restaurant(db, name="AO Delta")
    main, _ = items
    diner_payload, _ = await register_diner(client, label="ao_d_diner")
    diner_id = _uuid.UUID(diner_payload["id"])
    staff = _make_staff(db, restaurant.id, label="ao_d_staff")

    now = datetime.now(UTC)
    # Current window (last 7 days): 60000
    _seed_billed_session(
        db,
        restaurant_id=restaurant.id,
        diner_user_id=diner_id,
        menu_item_id=main.id,
        when=now - timedelta(days=1),
        total_minor=60000,
    )
    # Prior window (7-14 days ago): 40000 → delta = +50%
    _seed_billed_session(
        db,
        restaurant_id=restaurant.id,
        diner_user_id=diner_id,
        menu_item_id=main.id,
        when=now - timedelta(days=10),
        total_minor=40000,
    )

    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/analytics-overview?range=7d",
        headers={"Authorization": f"Bearer {token}"},
    )
    body = res.json()
    assert body["revenue"]["total_minor"] == 60000
    assert body["revenue"]["prior_period_total_minor"] == 40000
    assert body["revenue"]["delta_pct"] == 50.0


@pytest.mark.asyncio
async def test_peak_hours_bucketed_in_restaurant_tz(client, db):
    """A session started at 2026-07-15 14:00 in Asia/Kolkata → the
    (dow=2 Wednesday, hour=14) bucket must show 1."""
    restaurant, items, _ = make_restaurant(db, name="AO Peak")
    main, _ = items
    diner_payload, _ = await register_diner(client, label="ao_pk_diner")
    diner_id = _uuid.UUID(diner_payload["id"])
    staff = _make_staff(db, restaurant.id, label="ao_pk_staff")

    tz = ZoneInfo(restaurant.timezone)  # Asia/Kolkata
    # 2026-07-15 is a Wednesday — Python weekday() == 2.
    local_start = datetime(2026, 7, 15, 14, 0, 0, tzinfo=tz)
    when_utc = local_start.astimezone(UTC)
    _seed_billed_session(
        db,
        restaurant_id=restaurant.id,
        diner_user_id=diner_id,
        menu_item_id=main.id,
        when=when_utc,
        total_minor=10000,
    )

    token = await login(client, staff.email)
    # Custom range that brackets the seeded moment. Use params= so `+`
    # in the timezone offset gets URL-encoded properly.
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/analytics-overview",
        params={
            "range": "custom",
            "from": (when_utc - timedelta(days=1)).isoformat(),
            "to": (when_utc + timedelta(days=1)).isoformat(),
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    buckets = {(b["dow"], b["hour"]): b["session_count"] for b in body["peak_hours"]["buckets"]}
    assert len(buckets) == 7 * 24
    assert buckets[(2, 14)] == 1
    # Every other bucket must be zero — one session, one bucket.
    others = sum(v for k, v in buckets.items() if k != (2, 14))
    assert others == 0


@pytest.mark.asyncio
async def test_top_items_ranked_by_count(client, db):
    """Two items ordered N vs M times → top_items sorted by count desc."""
    restaurant, items, _ = make_restaurant(db, name="AO Top")
    main, dessert = items
    diner_payload, _ = await register_diner(client, label="ao_t_diner")
    diner_id = _uuid.UUID(diner_payload["id"])
    staff = _make_staff(db, restaurant.id, label="ao_t_staff")

    now = datetime.now(UTC)
    # 3 mains, 1 dessert. Main's per-unit price is 30000 (see make_restaurant).
    for _ in range(3):
        _seed_billed_session(
            db,
            restaurant_id=restaurant.id,
            diner_user_id=diner_id,
            menu_item_id=main.id,
            when=now - timedelta(hours=1),
            total_minor=30000,
        )
    _seed_billed_session(
        db,
        restaurant_id=restaurant.id,
        diner_user_id=diner_id,
        menu_item_id=dessert.id,
        when=now - timedelta(hours=1),
        total_minor=10000,
    )

    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/analytics-overview?range=7d",
        headers={"Authorization": f"Bearer {token}"},
    )
    body = res.json()
    top = body["top_items"]
    assert len(top) == 2
    assert top[0]["name"] == main.name
    assert top[0]["count"] == 3
    assert top[0]["revenue_minor"] == 3 * 30000
    assert top[1]["name"] == dessert.name
    assert top[1]["count"] == 1


@pytest.mark.asyncio
async def test_diner_ratio_new_repeat_anonymous(client, db):
    """Seed one diner with a prior session (→ repeat), one first-timer
    (→ new), and one walk-in (→ anonymous)."""
    restaurant, items, _ = make_restaurant(db, name="AO Ratio")
    main, _ = items
    repeat_diner, _ = await register_diner(client, label="ao_r_rep")
    new_diner, _ = await register_diner(client, label="ao_r_new")
    repeat_id = _uuid.UUID(repeat_diner["id"])
    new_id = _uuid.UUID(new_diner["id"])
    staff = _make_staff(db, restaurant.id, label="ao_r_staff")

    now = datetime.now(UTC)
    # Repeat diner: prior session 20 days ago, current in-range.
    _seed_billed_session(
        db,
        restaurant_id=restaurant.id,
        diner_user_id=repeat_id,
        menu_item_id=main.id,
        when=now - timedelta(days=20),
        total_minor=30000,
    )
    _seed_billed_session(
        db,
        restaurant_id=restaurant.id,
        diner_user_id=repeat_id,
        menu_item_id=main.id,
        when=now - timedelta(days=1),
        total_minor=30000,
    )
    # New diner: only in-range session.
    _seed_billed_session(
        db,
        restaurant_id=restaurant.id,
        diner_user_id=new_id,
        menu_item_id=main.id,
        when=now - timedelta(hours=6),
        total_minor=30000,
    )
    # Walk-in: no diner_user_id.
    _seed_billed_session(
        db,
        restaurant_id=restaurant.id,
        diner_user_id=None,
        menu_item_id=main.id,
        when=now - timedelta(hours=3),
        total_minor=30000,
    )

    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/analytics-overview?range=7d",
        headers={"Authorization": f"Bearer {token}"},
    )
    body = res.json()
    assert body["diner_ratio"]["new_count"] == 1
    assert body["diner_ratio"]["repeat_count"] == 1
    assert body["diner_ratio"]["anonymous_count"] == 1


@pytest.mark.asyncio
async def test_auth_cross_restaurant_staff_rejected(client, db):
    """Staff of restaurant A cannot read restaurant B's analytics."""
    rest_a, _, _ = make_restaurant(db, name="AO Auth A")
    rest_b, _, _ = make_restaurant(db, name="AO Auth B")
    staff_a = _make_staff(db, rest_a.id, label="ao_auth_a")
    token = await login(client, staff_a.email)
    res = await client.get(
        f"/api/v1/restaurants/{rest_b.id}/dashboard/analytics-overview?range=7d",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 403
    body = res.json()
    assert body["error"]["code"] == "NOT_RESTAURANT_STAFF"


@pytest.mark.asyncio
async def test_custom_range_respected(client, db):
    """When range=custom the response echoes the exact from/to bounds
    passed in the query string."""
    restaurant, _, _ = make_restaurant(db, name="AO Custom")
    staff = _make_staff(db, restaurant.id, label="ao_custom")
    token = await login(client, staff.email)
    from_dt = datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)
    to_dt = datetime(2026, 2, 1, 0, 0, 0, tzinfo=UTC)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/analytics-overview",
        params={
            "range": "custom",
            "from": from_dt.isoformat(),
            "to": to_dt.isoformat(),
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["range"]["label"] == "Custom range"
    assert datetime.fromisoformat(body["range"]["from"]) == from_dt
    assert datetime.fromisoformat(body["range"]["to"]) == to_dt


@pytest.mark.asyncio
async def test_custom_range_missing_bounds_400(client, db):
    """range=custom without both from/to → 400 INVALID_RANGE."""
    restaurant, _, _ = make_restaurant(db, name="AO Bad Custom")
    staff = _make_staff(db, restaurant.id, label="ao_badc")
    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/analytics-overview?range=custom",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_empty_restaurant_shape(client, db):
    """Fresh restaurant with no bills → all zeros, deltas null,
    peak_hours has full 168-bucket grid."""
    restaurant, _, _ = make_restaurant(db, name="AO Empty")
    staff = _make_staff(db, restaurant.id, label="ao_empty")
    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/analytics-overview?range=30d",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["revenue"]["total_minor"] == 0
    assert body["revenue"]["delta_pct"] is None
    assert len(body["peak_hours"]["buckets"]) == 7 * 24
    assert all(b["session_count"] == 0 for b in body["peak_hours"]["buckets"])
    assert body["top_items"] == []
    assert body["avg_ticket"]["minor"] == 0
    assert body["diner_ratio"] == {
        "new_count": 0,
        "repeat_count": 0,
        "anonymous_count": 0,
    }
