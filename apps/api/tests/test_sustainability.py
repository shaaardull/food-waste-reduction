"""Tests for the sustainability service + GET /auth/me/sustainability.

Ethics rule 3 — "you saved 0.4 kg CO₂e this month" copy.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from app.services import sustainability as svc

# -- unit tests on the pure compute function ----------------------------------


def test_empty_history_zero_savings():
    report = svc.compute([], period_days=30)
    assert report.sessions_counted == 0
    assert report.kg_food_saved == 0.0
    assert report.kg_co2e_saved == 0.0


def test_single_high_score_main_dish():
    # final_score 0.9 vs baseline 0.6 = 0.3 delta * 350g main = 105g saved.
    s = svc.SessionInput(
        final_score=Decimal("0.9"),
        item_categories=[("main", 1)],
    )
    report = svc.compute([s], period_days=30)
    assert report.sessions_counted == 1
    # 105g = 0.105 kg food → rounded to 0.1.
    assert report.kg_food_saved == 0.1
    # 0.105 kg × 2.5 = 0.26.
    assert report.kg_co2e_saved == 0.26


def test_below_baseline_not_penalised():
    # 0.5 < 0.6 baseline — should count session but add zero savings.
    s = svc.SessionInput(
        final_score=Decimal("0.5"),
        item_categories=[("main", 1)],
    )
    report = svc.compute([s], period_days=30)
    assert report.sessions_counted == 1
    assert report.kg_food_saved == 0.0


def test_multi_session_aggregation():
    sessions = [
        # 0.8 score: delta 0.2 × main(350) + side(100) = 0.2 × 450 = 90g
        svc.SessionInput(
            final_score=Decimal("0.8"),
            item_categories=[("main", 1), ("side", 1)],
        ),
        # 0.95 score: delta 0.35 × main(350) = 122.5g
        svc.SessionInput(
            final_score=Decimal("0.95"),
            item_categories=[("main", 1)],
        ),
        # below baseline — no contribution but still counted
        svc.SessionInput(
            final_score=Decimal("0.55"),
            item_categories=[("main", 1)],
        ),
    ]
    report = svc.compute(sessions, period_days=30)
    assert report.sessions_counted == 3
    # 90 + 122.5 = 212.5g = 0.21 kg
    assert report.kg_food_saved == 0.21


def test_unknown_category_uses_default_weight():
    s = svc.SessionInput(
        final_score=Decimal("1.0"),
        item_categories=[("mystery", 1)],
    )
    report = svc.compute([s], period_days=30)
    # delta 0.4 × default 200g = 80g
    assert report.kg_food_saved == 0.08


# -- integration test on the endpoint -----------------------------------------


@pytest.mark.asyncio
async def test_sustainability_endpoint_empty_for_new_user(client):
    from tests.conftest import register_diner

    user, token = await register_diner(client, label="susempty")
    res = await client.get(
        "/api/v1/auth/me/sustainability",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["sessions_counted"] == 0
    assert body["kg_food_saved"] == 0.0


@pytest.mark.asyncio
async def test_sustainability_endpoint_after_approval(client, db):
    """Seed a session + items + staff_validation for a known diner and
    confirm the endpoint sums savings correctly."""
    from sqlalchemy import select

    from app.models.meal_session import MealSession, MealSessionItem
    from app.models.staff_validation import StaffValidation
    from app.models.user import User
    from tests.conftest import login, make_restaurant, make_table_code, register_diner

    restaurant, items, _ = make_restaurant(db, name="Sustain Endpoint")
    diner_payload, _ = await register_diner(client, label="susend")

    diner = db.execute(
        select(User).where(User.email == diner_payload["email"])
    ).scalar_one()

    now = datetime.now(UTC)
    session = MealSession(
        diner_user_id=diner.id,
        restaurant_id=restaurant.id,
        table_code=make_table_code("sustain"),
        status="rewarded",
        started_at=now - timedelta(days=2),
        expires_at=now - timedelta(days=2) + timedelta(hours=4),
    )
    db.add(session)
    db.flush()
    # Order one main (350g default).
    main = items[0]
    db.add(
        MealSessionItem(
            meal_session_id=session.id,
            menu_item_id=main.id,
            quantity=1,
            portion_size="small",
        )
    )
    db.add(
        StaffValidation(
            meal_session_id=session.id,
            staff_user_id=diner.id,  # any FK-valid user id works for this test
            restaurant_id=restaurant.id,
            decision="approved",
            model_score=Decimal("0.9"),
            final_score=Decimal("0.9"),
            decided_at=now - timedelta(days=1),
            decision_latency_ms=1000,
        )
    )
    db.commit()

    token = await login(client, diner.email)
    res = await client.get(
        "/api/v1/auth/me/sustainability?days=30",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["sessions_counted"] == 1
    # main category — 350g × (0.9 - 0.6) = 105g = 0.1 kg (rounded).
    assert body["kg_food_saved"] == 0.1
    assert body["kg_co2e_saved"] == 0.26
