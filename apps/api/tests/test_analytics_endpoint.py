"""Integration tests for GET /restaurants/:id/dashboard/analytics.

Covers the rollup endpoint that powers the restaurant analytics screen:
counts, decision-latency percentiles, top dishes by avg consumption,
fraud-signal histogram, and aggregate sustainability impact.
"""
from __future__ import annotations

import uuid as _uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from app.models.consumption_score import ConsumptionScore
from app.models.fraud_signal import FraudSignal
from app.models.meal_session import MealSession, MealSessionItem
from app.models.restaurant import RestaurantStaff
from app.models.reward import Reward
from app.models.staff_validation import StaffValidation
from app.models.user import User
from app.security import hash_password
from tests.conftest import (
    login,
    make_email,
    make_restaurant,
    make_table_code,
    register_diner,
)


def _make_staff(db: Session, restaurant_id, *, label: str = "an_staff") -> User:
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


def _seed_session(
    db: Session,
    *,
    restaurant_id,
    diner_id,
    menu_item_id,
    staff_id,
    decision: str,
    final_score: Decimal,
    decision_latency_ms: int,
    decided_at: datetime,
    quantity: int = 1,
) -> MealSession:
    """One full meal-session row chain: session + item + score + validation."""
    session = MealSession(
        diner_user_id=diner_id,
        restaurant_id=restaurant_id,
        table_code=make_table_code("an"),
        status=("rewarded" if decision != "rejected" else "staff_rejected"),
        started_at=decided_at - timedelta(minutes=30),
        expires_at=decided_at + timedelta(hours=4),
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
    db.add(
        ConsumptionScore(
            meal_session_id=session.id,
            overall_score=final_score,
            per_item_scores=[{"menu_item_id": str(menu_item_id), "score": float(final_score), "confidence": 0.9}],
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
            decision=decision,
            model_score=final_score,
            final_score=final_score,
            reason_code=None if decision == "approved" else "model_overestimated",
            decided_at=decided_at,
            decision_latency_ms=decision_latency_ms,
        )
    )
    db.commit()
    db.refresh(session)
    return session


@pytest.mark.asyncio
async def test_analytics_empty_restaurant(client, db):
    """No sessions yet → all zeros, rates are None, lists empty."""
    restaurant, _, _ = make_restaurant(db, name="An Empty")
    staff = _make_staff(db, restaurant.id, label="an_empty")
    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/analytics?range=7d",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["range"] == "7d"
    assert body["period_days"] == 7
    assert body["totals"] == {
        "sessions": 0,
        "approved": 0,
        "adjusted": 0,
        "rejected": 0,
        "decided": 0,
        "pending_validation": 0,
        "rewards_issued": 0,
        "rewards_redeemed": 0,
    }
    assert body["rates"] == {"approval_rate": None, "redemption_rate": None}
    assert body["avg_final_score"] is None
    assert body["decision_latency_ms"] == {"p50": None, "p95": None, "count": 0}
    assert body["top_dishes"] == []
    assert body["fraud_signals"] == []
    assert body["sustainability"]["kg_food_saved"] == 0.0


@pytest.mark.asyncio
async def test_analytics_with_validations_and_rewards(client, db):
    """Seed approved/adjusted/rejected sessions + a redeemed reward + a
    fraud signal. Assert the rollup numbers + top-dishes shape + sustainability."""
    restaurant, items, rule = make_restaurant(db, name="An Real")
    main, dessert = items
    diner_payload, _ = await register_diner(client, label="an_diner")
    diner_id = _uuid.UUID(diner_payload["id"])
    staff = _make_staff(db, restaurant.id, label="an_real_staff")

    now = datetime.now(UTC)
    # Approved at 0.85, decision in 30s.
    s_approved = _seed_session(
        db, restaurant_id=restaurant.id, diner_id=diner_id, menu_item_id=main.id,
        staff_id=staff.id, decision="approved", final_score=Decimal("0.85"),
        decision_latency_ms=30_000, decided_at=now - timedelta(hours=1),
    )
    # Adjusted at 0.78, decision in 60s.
    _seed_session(
        db, restaurant_id=restaurant.id, diner_id=diner_id, menu_item_id=main.id,
        staff_id=staff.id, decision="adjusted", final_score=Decimal("0.78"),
        decision_latency_ms=60_000, decided_at=now - timedelta(hours=2),
    )
    # Rejected at 0.40, decision in 120s.
    _seed_session(
        db, restaurant_id=restaurant.id, diner_id=diner_id, menu_item_id=dessert.id,
        staff_id=staff.id, decision="rejected", final_score=Decimal("0.40"),
        decision_latency_ms=120_000, decided_at=now - timedelta(hours=3),
    )

    # A reward for the approved session: half issued, half redeemed.
    reward = Reward(
        meal_session_id=s_approved.id,
        reward_rule_id=rule.id,
        redemption_code=make_table_code("AN").upper(),
        reward_type="menu_item",
        value_minor=10_000,
        issued_at=now - timedelta(hours=1),
        half_value_at=now + timedelta(days=15),
        expires_at=now + timedelta(days=30),
        redeemed_at=now - timedelta(minutes=30),
        redeemed_value_minor=10_000,
    )
    db.add(reward)
    # One fraud signal in-window.
    db.add(
        FraudSignal(
            meal_session_id=s_approved.id,
            user_id=diner_id,
            signal_type="geofence_violation",
            severity="warning",
            details={"distance_m": 250, "max_m": 100},
        )
    )
    db.commit()

    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/analytics?range=30d",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()

    # ── Totals
    t = body["totals"]
    assert t["sessions"] == 3
    assert t["approved"] == 1
    assert t["adjusted"] == 1
    assert t["rejected"] == 1
    assert t["decided"] == 3
    assert t["rewards_issued"] == 1
    assert t["rewards_redeemed"] == 1

    # ── Rates
    # approval_rate = (approved + adjusted) / decided = 2/3 ≈ 0.667
    assert body["rates"]["approval_rate"] == pytest.approx(0.667, abs=0.001)
    assert body["rates"]["redemption_rate"] == 1.0

    # ── Decision-latency percentiles
    # Three samples: 30000, 60000, 120000 — sorted.
    # p50 = 60000, p95 ≈ between 60000 and 120000.
    lat = body["decision_latency_ms"]
    assert lat["count"] == 3
    assert lat["p50"] == 60_000
    assert 60_000 < lat["p95"] <= 120_000

    # ── Top dishes — only approved+adjusted count; main has 2, dessert 0.
    names = {d["name"] for d in body["top_dishes"]}
    assert "Test Main" in names
    main_entry = next(d for d in body["top_dishes"] if d["name"] == "Test Main")
    assert main_entry["orders"] == 2
    # Average of 0.85 + 0.78 = 0.815
    assert main_entry["avg_final_score"] == pytest.approx(0.815, abs=0.001)

    # ── Fraud signals
    assert len(body["fraud_signals"]) == 1
    assert body["fraud_signals"][0]["signal_type"] == "geofence_violation"
    assert body["fraud_signals"][0]["severity_counts"]["warning"] == 1
    assert body["fraud_signals"][0]["total"] == 1

    # ── Sustainability — approved+adjusted sessions count
    # Both used "main" category (default 350g, qty 1) → 350g per session.
    # delta_approved = 0.85 - 0.60 = 0.25; delta_adjusted = 0.78 - 0.60 = 0.18.
    # saved_grams = (0.25 + 0.18) * 350 ≈ 150.5g
    sus = body["sustainability"]
    assert sus["sessions_counted"] == 2
    assert sus["kg_food_saved"] == pytest.approx(0.15, abs=0.01)
    assert sus["kg_co2e_saved"] == pytest.approx(0.38, abs=0.02)


@pytest.mark.asyncio
async def test_analytics_rejects_non_staff(client, db):
    """A diner without staff role gets 403."""
    restaurant, _, _ = make_restaurant(db, name="An Forbid")
    _, token = await register_diner(client, label="an_forbid")
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/analytics",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_analytics_does_not_leak_across_restaurants(client, db):
    """Sessions at restaurant A must not show up in restaurant B's analytics."""
    rest_a, items_a, _ = make_restaurant(db, name="An A")
    rest_b, _, _ = make_restaurant(db, name="An B")
    main_a, _ = items_a
    diner_payload, _ = await register_diner(client, label="an_leak")
    diner_id = _uuid.UUID(diner_payload["id"])
    staff_a = _make_staff(db, rest_a.id, label="an_leak_a")
    staff_b = _make_staff(db, rest_b.id, label="an_leak_b")

    # One approved session at restaurant A.
    _seed_session(
        db, restaurant_id=rest_a.id, diner_id=diner_id, menu_item_id=main_a.id,
        staff_id=staff_a.id, decision="approved", final_score=Decimal("0.9"),
        decision_latency_ms=20_000, decided_at=datetime.now(UTC) - timedelta(hours=1),
    )

    # Staff B asks for B's analytics — should see zero.
    token = await login(client, staff_b.email)
    res = await client.get(
        f"/api/v1/restaurants/{rest_b.id}/dashboard/analytics?range=7d",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["totals"]["sessions"] == 0
    assert body["totals"]["approved"] == 0
    assert body["top_dishes"] == []
