"""Integration tests for app.tasks.anomaly.score_anomaly_scan.

These tests require the same Postgres database the API uses. They open
synchronous sessions directly (mirroring the Celery task) and exercise
the _scan helper without enqueueing through the broker.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, delete, text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.consumption_score import ConsumptionScore
from app.models.fraud_signal import FraudSignal
from app.models.meal_session import MealSession
from app.models.restaurant import Restaurant
from app.models.user import User
from app.tasks.anomaly import ANOMALY_WINDOW_SCORES, _scan

settings = get_settings()


@pytest.fixture
def db() -> Session:
    engine = create_engine(settings.DATABASE_URL_SYNC, future=True)
    with Session(engine, future=True) as session:
        yield session


@pytest.fixture(autouse=True)
def cleanup(db: Session):
    """Hard-reset our test artefacts so tests are independent."""
    db.execute(delete(FraudSignal).where(FraudSignal.signal_type == "score_distribution_anomaly"))
    db.execute(
        text(
            "DELETE FROM consumption_scores WHERE meal_session_id IN "
            "(SELECT id FROM meal_sessions WHERE table_code LIKE 'TEST-ANOMALY-%')"
        )
    )
    db.execute(
        text("DELETE FROM meal_sessions WHERE table_code LIKE 'TEST-ANOMALY-%'")
    )
    db.execute(text("DELETE FROM users WHERE email LIKE 'anomaly-test-%'"))
    db.commit()
    yield
    db.execute(delete(FraudSignal).where(FraudSignal.signal_type == "score_distribution_anomaly"))
    db.execute(
        text(
            "DELETE FROM consumption_scores WHERE meal_session_id IN "
            "(SELECT id FROM meal_sessions WHERE table_code LIKE 'TEST-ANOMALY-%')"
        )
    )
    db.execute(text("DELETE FROM meal_sessions WHERE table_code LIKE 'TEST-ANOMALY-%'"))
    db.execute(text("DELETE FROM users WHERE email LIKE 'anomaly-test-%'"))
    db.commit()


def _make_user(db: Session, idx: int) -> User:
    u = User(
        email=f"anomaly-test-{idx}-{datetime.now().timestamp()}@example.com",
        display_name=f"Anomaly Test {idx}",
        role="diner",
    )
    db.add(u)
    db.flush()
    return u


def _restaurant(db: Session) -> Restaurant:
    return db.execute(
        text("SELECT id FROM restaurants LIMIT 1")
    ).scalar_one_or_none() and db.execute(
        Restaurant.__table__.select().limit(1)
    ).first()[0:1] or None or db.execute(  # noqa: PLR0911
        Restaurant.__table__.select().limit(1)
    ).first()


def _make_session_with_score(
    db: Session, user: User, restaurant_id, score_val: Decimal, age_minutes: int = 0
) -> None:
    now = datetime.now(UTC)
    session = MealSession(
        diner_user_id=user.id,
        restaurant_id=restaurant_id,
        table_code=f"TEST-ANOMALY-{user.id}-{age_minutes}",
        status="rewarded",
        started_at=now - timedelta(minutes=age_minutes),
        expires_at=now - timedelta(minutes=age_minutes) + timedelta(hours=4),
    )
    db.add(session)
    db.flush()
    score = ConsumptionScore(
        meal_session_id=session.id,
        overall_score=score_val,
        per_item_scores=[],
        model_name="test",
        model_version="0",
        processing_ms=10,
        confidence=Decimal("0.9"),
    )
    db.add(score)
    db.flush()


def test_anomaly_no_signal_when_under_10_scores(db: Session):
    restaurant_id = db.execute(text("SELECT id FROM restaurants LIMIT 1")).scalar_one()
    user = _make_user(db, 1)
    for i in range(5):
        _make_session_with_score(db, user, restaurant_id, Decimal("0.99"), age_minutes=i)
    db.commit()
    emitted = _scan(db, datetime.now(UTC))
    assert emitted == 0


def test_anomaly_signal_when_last_10_all_high(db: Session):
    restaurant_id = db.execute(text("SELECT id FROM restaurants LIMIT 1")).scalar_one()
    user = _make_user(db, 2)
    for i in range(ANOMALY_WINDOW_SCORES):
        _make_session_with_score(db, user, restaurant_id, Decimal("0.97"), age_minutes=i)
    db.commit()
    emitted = _scan(db, datetime.now(UTC))
    assert emitted == 1
    signal = db.execute(
        FraudSignal.__table__.select().where(FraudSignal.user_id == user.id)
    ).first()
    assert signal is not None


def test_anomaly_no_signal_when_one_score_low(db: Session):
    restaurant_id = db.execute(text("SELECT id FROM restaurants LIMIT 1")).scalar_one()
    user = _make_user(db, 3)
    # 9 high, 1 low → should not flag
    for i in range(ANOMALY_WINDOW_SCORES - 1):
        _make_session_with_score(db, user, restaurant_id, Decimal("0.97"), age_minutes=i + 1)
    _make_session_with_score(db, user, restaurant_id, Decimal("0.60"), age_minutes=0)
    db.commit()
    emitted = _scan(db, datetime.now(UTC))
    assert emitted == 0


def test_anomaly_dedupes_within_24h(db: Session):
    restaurant_id = db.execute(text("SELECT id FROM restaurants LIMIT 1")).scalar_one()
    user = _make_user(db, 4)
    for i in range(ANOMALY_WINDOW_SCORES):
        _make_session_with_score(db, user, restaurant_id, Decimal("0.99"), age_minutes=i)
    db.commit()
    assert _scan(db, datetime.now(UTC)) == 1
    # Running again immediately should NOT double-flag.
    assert _scan(db, datetime.now(UTC)) == 0
