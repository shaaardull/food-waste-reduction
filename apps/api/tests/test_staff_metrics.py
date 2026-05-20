"""Integration tests for app.tasks.staff_metrics.

Builds synthetic validation history across 4 weeks and verifies the
weekly task writes snapshots and raises a manual_flag fraud_signal when
a staff member has rejected at > 2× the restaurant median for 4
consecutive weeks.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.fraud_signal import FraudSignal
from app.models.meal_session import MealSession
from app.models.restaurant import RestaurantStaff
from app.models.staff_metrics import StaffMetricsSnapshot
from app.models.staff_validation import StaffValidation
from app.models.user import User
from app.tasks.staff_metrics import _check_alerts, _compute_week, _week_window

settings = get_settings()


@pytest.fixture
def db() -> Session:
    engine = create_engine(settings.DATABASE_URL_SYNC, future=True)
    with Session(engine, future=True) as session:
        yield session


@pytest.fixture(autouse=True)
def cleanup(db: Session):
    db.execute(
        text(
            "DELETE FROM fraud_signals WHERE user_id IN "
            "(SELECT id FROM users WHERE email LIKE 'staff-metrics-test-%')"
        )
    )
    db.execute(
        text(
            "DELETE FROM staff_metrics_snapshots WHERE staff_user_id IN "
            "(SELECT id FROM users WHERE email LIKE 'staff-metrics-test-%')"
        )
    )
    db.execute(
        text(
            "DELETE FROM staff_validations WHERE staff_user_id IN "
            "(SELECT id FROM users WHERE email LIKE 'staff-metrics-test-%')"
        )
    )
    db.execute(
        text(
            "DELETE FROM meal_sessions WHERE table_code LIKE 'TEST-STAFF-METRICS-%'"
        )
    )
    db.execute(
        text(
            "DELETE FROM restaurant_staff WHERE user_id IN "
            "(SELECT id FROM users WHERE email LIKE 'staff-metrics-test-%')"
        )
    )
    db.execute(text("DELETE FROM users WHERE email LIKE 'staff-metrics-test-%'"))
    db.commit()
    yield


def _make_staff(db: Session, idx: int, restaurant_id) -> User:
    u = User(
        email=f"staff-metrics-test-{idx}-{datetime.now().timestamp()}@example.com",
        display_name=f"Staff {idx}",
        role="staff",
    )
    db.add(u)
    db.flush()
    db.add(RestaurantStaff(user_id=u.id, restaurant_id=restaurant_id, role="server"))
    db.flush()
    return u


def _make_diner(db: Session, idx: int) -> User:
    u = User(
        email=f"staff-metrics-test-diner-{idx}-{datetime.now().timestamp()}@example.com",
        role="diner",
    )
    db.add(u)
    db.flush()
    return u


def _make_validation(
    db: Session,
    staff: User,
    diner: User,
    restaurant_id,
    decision: str,
    decided_at: datetime,
) -> None:
    session = MealSession(
        diner_user_id=diner.id,
        restaurant_id=restaurant_id,
        table_code=f"TEST-STAFF-METRICS-{staff.id}-{decided_at.timestamp()}",
        status="staff_approved" if decision != "rejected" else "staff_rejected",
        started_at=decided_at,
        expires_at=decided_at + timedelta(hours=4),
    )
    db.add(session)
    db.flush()
    db.add(
        StaffValidation(
            meal_session_id=session.id,
            staff_user_id=staff.id,
            restaurant_id=restaurant_id,
            decision=decision,
            model_score=Decimal("0.8"),
            final_score=Decimal("0.8") if decision != "rejected" else Decimal("0"),
            reason_code="model_overestimated" if decision != "approved" else None,
            decided_at=decided_at,
            decision_latency_ms=1000,
        )
    )
    db.flush()


def test_week_window_starts_seven_days_back(db: Session):
    now = datetime(2026, 5, 25, 14, 30, tzinfo=UTC)
    start, end = _week_window(now)
    assert (end - start).days == 7
    assert end.hour == 0
    assert end.minute == 0


def test_compute_week_writes_snapshot(db: Session):
    # Use a dedicated restaurant so stale validations from prior tests or
    # live-stack smokes don't bleed into the aggregate.
    from tests.conftest import make_restaurant

    restaurant, _, _ = make_restaurant(db, name="StaffMetrics Compute")
    restaurant_id = restaurant.id
    staff = _make_staff(db, 100, restaurant_id)
    diner = _make_diner(db, 1)
    now = datetime.now(UTC)
    inside = now - timedelta(days=1)
    for _ in range(8):
        _make_validation(db, staff, diner, restaurant_id, "approved", inside)
    for _ in range(2):
        _make_validation(db, staff, diner, restaurant_id, "rejected", inside)
    db.commit()
    start, end = _week_window(now + timedelta(days=1))  # so today is inside the window
    written = _compute_week(db, start, end)
    db.commit()
    # `written` is the global count of (staff, restaurant) pairs the week
    # aggregator touched. Other tests in this pytest session may have
    # produced their own validations, so we just assert it's ≥ 1 and the
    # snapshot for OUR staff has the right shape.
    assert written >= 1
    snap = db.execute(
        StaffMetricsSnapshot.__table__.select().where(
            StaffMetricsSnapshot.staff_user_id == staff.id
        )
    ).first()
    assert snap is not None
    assert snap.validations_count == 10
    assert snap.approvals_count == 8
    assert snap.rejections_count == 2
    assert float(snap.rejection_rate) == 0.2


def test_alert_fires_after_four_high_weeks(db: Session):
    restaurant_id = db.execute(text("SELECT id FROM restaurants LIMIT 1")).scalar_one()
    high = _make_staff(db, 200, restaurant_id)
    low = _make_staff(db, 201, restaurant_id)
    db.commit()

    # Build 4 consecutive weekly snapshots manually so we don't have to fake
    # 28 days of validation history. high has rejection_rate 0.8 each week;
    # low has 0.1 each week; restaurant median is 0.3, so 0.8 > 2× 0.3 = 0.6.
    base_period_start = datetime(2026, 4, 27, 0, 0, tzinfo=UTC)  # a Monday
    for w in range(4):
        period_start = base_period_start + timedelta(weeks=w)
        period_end = period_start + timedelta(days=7)
        median = Decimal("0.3")
        db.add(
            StaffMetricsSnapshot(
                staff_user_id=high.id,
                restaurant_id=restaurant_id,
                period_start=period_start,
                period_end=period_end,
                validations_count=20,
                approvals_count=4,
                rejections_count=16,
                adjustments_count=0,
                rejection_rate=Decimal("0.8"),
                approval_rate=Decimal("0.2"),
                restaurant_median_rejection_rate=median,
            )
        )
        db.add(
            StaffMetricsSnapshot(
                staff_user_id=low.id,
                restaurant_id=restaurant_id,
                period_start=period_start,
                period_end=period_end,
                validations_count=20,
                approvals_count=18,
                rejections_count=2,
                adjustments_count=0,
                rejection_rate=Decimal("0.1"),
                approval_rate=Decimal("0.9"),
                restaurant_median_rejection_rate=median,
            )
        )
    db.commit()

    latest_start = base_period_start + timedelta(weeks=3)
    alerts = _check_alerts(db, latest_start)
    db.commit()
    assert alerts == 1
    flagged = db.execute(
        FraudSignal.__table__.select().where(FraudSignal.user_id == high.id)
    ).first()
    assert flagged is not None
    # The low-rejection staff should NOT be flagged.
    not_flagged = db.execute(
        FraudSignal.__table__.select().where(FraudSignal.user_id == low.id)
    ).first()
    assert not_flagged is None


def test_alert_does_not_fire_with_only_three_weeks(db: Session):
    restaurant_id = db.execute(text("SELECT id FROM restaurants LIMIT 1")).scalar_one()
    staff = _make_staff(db, 300, restaurant_id)
    db.commit()
    base_period_start = datetime(2026, 4, 27, 0, 0, tzinfo=UTC)
    for w in range(3):  # only 3 weeks
        period_start = base_period_start + timedelta(weeks=w)
        period_end = period_start + timedelta(days=7)
        db.add(
            StaffMetricsSnapshot(
                staff_user_id=staff.id,
                restaurant_id=restaurant_id,
                period_start=period_start,
                period_end=period_end,
                validations_count=20,
                approvals_count=8,
                rejections_count=12,
                adjustments_count=0,
                rejection_rate=Decimal("0.6"),
                approval_rate=Decimal("0.4"),
                restaurant_median_rejection_rate=Decimal("0.2"),
            )
        )
    db.commit()
    latest_start = base_period_start + timedelta(weeks=2)
    alerts = _check_alerts(db, latest_start)
    assert alerts == 0
