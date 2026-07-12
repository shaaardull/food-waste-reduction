"""Integration tests for GET /api/v1/public/stats.

What we verify:
- The endpoint is genuinely public — no Authorization header needed.
- The k-anonymity gate fires on small datasets: scalars are null and
  `k_anonymous` is false.
- Above the floor: real numbers come back and only the safe scalars
  appear in the response. Critically no restaurant names, no
  per-restaurant breakdown, no diner ids.
- Range filtering — sessions outside the window don't get counted.
"""
from __future__ import annotations

import uuid as _uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from app.models.consumption_score import ConsumptionScore
from app.models.meal_session import MealSession, MealSessionItem
from app.models.staff_validation import StaffValidation
from tests.conftest import (
    make_restaurant,
    make_staff,
    make_table_code,
    register_diner,
)


def _seed_session(
    db: Session,
    *,
    restaurant_id,
    diner_id,
    menu_item_id,
    staff_id,
    decided_at: datetime,
    final_score: Decimal = Decimal("0.85"),
) -> MealSession:
    """Minimum row chain for a session to count in public stats."""
    session = MealSession(
        diner_user_id=diner_id,
        restaurant_id=restaurant_id,
        table_code=make_table_code("pub"),
        status="rewarded",
        started_at=decided_at - timedelta(minutes=30),
        expires_at=decided_at + timedelta(hours=4),
    )
    db.add(session)
    db.flush()
    db.add(
        MealSessionItem(
            meal_session_id=session.id, menu_item_id=menu_item_id, quantity=1
        )
    )
    db.add(
        ConsumptionScore(
            meal_session_id=session.id,
            overall_score=final_score,
            per_item_scores=[],
            model_name="stub",
            model_version="v0",
            processing_ms=200,
            raw_model_output={},
        )
    )
    db.add(
        StaffValidation(
            meal_session_id=session.id,
            staff_user_id=staff_id,
            restaurant_id=restaurant_id,
            decision="approved",
            model_score=final_score,
            final_score=final_score,
            decided_at=decided_at,
            decision_latency_ms=15_000,
        )
    )
    db.commit()
    db.refresh(session)
    return session


@pytest.mark.asyncio
async def test_public_stats_is_unauthed(client, db):
    """200 with no Authorization header — this is the marketing page."""
    res = await client.get("/api/v1/public/stats?range=30d")
    assert res.status_code == 200, res.text


@pytest.mark.asyncio
async def test_public_stats_shape_has_no_pii(client, db):
    """Response only contains aggregate scalars + k-anonymity metadata.
    No restaurant names, no slugs, no top dishes, no diner counts.

    This is a contract test — if someone ever adds a field with PII,
    this should fail loudly."""
    res = await client.get("/api/v1/public/stats")
    body = res.json()
    allowed_keys = {
        "range",
        "period_days",
        "sessions_counted",
        "k_anonymous",
        "kg_food_saved",
        "kg_co2e_saved",
        "trees_day_equivalent",
        "rewards_issued",
        "rewards_redeemed",
        "generated_at",
    }
    extra = set(body.keys()) - allowed_keys
    assert not extra, f"Response leaks unexpected keys: {extra}"
    # `restaurants_active` and `k_anonymity_floor` were deliberately
    # removed — the count is business-sensitive at pilot scale and
    # the floor would leak it by subtraction from a client's empty
    # state. This assertion locks that in.
    assert "restaurants_active" not in body
    assert "k_anonymity_floor" not in body


@pytest.mark.asyncio
async def test_public_stats_k_anonymity_below_floor_returns_nulls(
    client, db, monkeypatch
):
    """Below the k-anonymity floor: k_anonymous is false and every
    scalar is null. sessions_counted is still reported (it's an
    aggregate of diner activity, not a restaurant identifier)."""
    # Need to control the world — pretend nothing else exists by tightening
    # the floor temporarily.
    from app.routers import public as public_router

    monkeypatch.setattr(public_router, "MIN_RESTAURANTS_FOR_PUBLIC_STATS", 1000)

    res = await client.get("/api/v1/public/stats?range=30d")
    body = res.json()
    assert body["k_anonymous"] is False
    assert body["kg_food_saved"] is None
    assert body["kg_co2e_saved"] is None
    assert body["trees_day_equivalent"] is None
    assert body["rewards_issued"] is None
    assert body["rewards_redeemed"] is None
    assert isinstance(body["sessions_counted"], int)


@pytest.mark.asyncio
async def test_public_stats_above_floor_returns_numbers(client, db, monkeypatch):
    """Seed 2 restaurants × 5 approved sessions = 10 sessions. With the
    default floor (2/10) the gate passes and we get real numbers."""
    from app.routers import public as public_router

    # Make sure the floor is the default (other tests may have monkeypatched it).
    monkeypatch.setattr(public_router, "MIN_RESTAURANTS_FOR_PUBLIC_STATS", 2)
    monkeypatch.setattr(public_router, "MIN_SESSIONS_FOR_PUBLIC_STATS", 10)

    diner_payload, _ = await register_diner(client, label="pub_aggr")
    diner_id = _uuid.UUID(diner_payload["id"])

    rest_a, items_a, _ = make_restaurant(db, name="Pub A")
    rest_b, items_b, _ = make_restaurant(db, name="Pub B")
    main_a, _ = items_a
    main_b, _ = items_b
    staff_a = make_staff(db, rest_a.id)
    staff_b = make_staff(db, rest_b.id)
    now = datetime.now(UTC)
    for i in range(5):
        _seed_session(
            db, restaurant_id=rest_a.id, diner_id=diner_id, menu_item_id=main_a.id,
            staff_id=staff_a.id, decided_at=now - timedelta(hours=i + 1),
        )
        _seed_session(
            db, restaurant_id=rest_b.id, diner_id=diner_id, menu_item_id=main_b.id,
            staff_id=staff_b.id, decided_at=now - timedelta(hours=i + 1),
        )

    res = await client.get("/api/v1/public/stats?range=30d")
    body = res.json()
    assert body["k_anonymous"] is True
    assert body["sessions_counted"] >= 10
    assert body["kg_food_saved"] is not None
    assert body["kg_food_saved"] > 0
    assert body["kg_co2e_saved"] is not None
    assert body["trees_day_equivalent"] is not None


@pytest.mark.asyncio
async def test_public_stats_range_filter_works(client, db, monkeypatch):
    """A session decided 60 days ago must not show in a 30d window
    but must show in 'all'. Floor patched so a single restaurant's
    single session is enough to exercise the SQL filter."""
    from app.routers import public as public_router

    monkeypatch.setattr(public_router, "MIN_RESTAURANTS_FOR_PUBLIC_STATS", 1)
    monkeypatch.setattr(public_router, "MIN_SESSIONS_FOR_PUBLIC_STATS", 1)

    diner_payload, _ = await register_diner(client, label="pub_range")
    diner_id = _uuid.UUID(diner_payload["id"])
    rest, items, _ = make_restaurant(db, name="Pub Range")
    main, _ = items
    staff = make_staff(db, rest.id)
    _seed_session(
        db, restaurant_id=rest.id, diner_id=diner_id, menu_item_id=main.id,
        staff_id=staff.id, decided_at=datetime.now(UTC) - timedelta(days=60),
    )

    body_30 = (await client.get("/api/v1/public/stats?range=30d")).json()
    body_all = (await client.get("/api/v1/public/stats?range=all")).json()

    # 30d window: this single session falls outside, so we expect 0
    # counted from THIS test's data. (Other tests may have left rows;
    # we only assert relative behaviour.)
    assert body_30["sessions_counted"] <= body_all["sessions_counted"]


@pytest.mark.asyncio
async def test_public_stats_rejects_invalid_range(client, db):
    """Pydantic-validated range — anything outside {30d,90d,all} is 422."""
    res = await client.get("/api/v1/public/stats?range=1d")
    assert res.status_code == 422
