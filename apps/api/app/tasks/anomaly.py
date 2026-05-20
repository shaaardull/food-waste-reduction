"""Daily Celery job that scans for diners whose recent scores look suspiciously high.

Fraud signal #10 (CLAUDE.md §7): "For any user whose last 10 scores are all
≥ 0.95, create a fraud_signal for manual review."

Runs once a day via Celery Beat (see app.celery_app). Idempotent: if a signal
for the same user already exists in the last 24 hours, skip.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.celery_app import celery_app
from app.config import get_settings
from app.logging import get_logger
from app.models.consumption_score import ConsumptionScore
from app.models.fraud_signal import FraudSignal
from app.models.meal_session import MealSession

log = get_logger(__name__)
settings = get_settings()

_engine = create_engine(settings.DATABASE_URL_SYNC, pool_pre_ping=True, future=True)

ANOMALY_THRESHOLD = Decimal("0.95")
ANOMALY_WINDOW_SCORES = 10


def _scan(db: Session, now: datetime) -> int:
    """Returns the number of new fraud_signals emitted."""
    yesterday = now - timedelta(hours=24)
    emitted = 0

    # All diners that have a score recorded in the last 30 days. (No point
    # scanning users who haven't been active.)
    recent_cutoff = now - timedelta(days=30)
    candidate_user_ids = list(
        db.execute(
            select(MealSession.diner_user_id)
            .join(ConsumptionScore, ConsumptionScore.meal_session_id == MealSession.id)
            .where(ConsumptionScore.created_at >= recent_cutoff)
            .distinct()
        ).scalars()
    )

    for user_id in candidate_user_ids:
        last_scores = list(
            db.execute(
                select(ConsumptionScore.overall_score)
                .join(MealSession, MealSession.id == ConsumptionScore.meal_session_id)
                .where(MealSession.diner_user_id == user_id)
                .order_by(ConsumptionScore.created_at.desc())
                .limit(ANOMALY_WINDOW_SCORES)
            ).scalars()
        )
        if len(last_scores) < ANOMALY_WINDOW_SCORES:
            continue
        if not all(Decimal(str(s)) >= ANOMALY_THRESHOLD for s in last_scores):
            continue

        # Skip if we already flagged this user in the last 24h — keeps the
        # signal queue from re-issuing every night.
        existing = db.execute(
            select(FraudSignal.id).where(
                FraudSignal.user_id == user_id,
                FraudSignal.signal_type == "score_distribution_anomaly",
                FraudSignal.created_at >= yesterday,
            )
        ).first()
        if existing:
            continue

        db.add(
            FraudSignal(
                user_id=user_id,
                signal_type="score_distribution_anomaly",
                severity="warning",
                details={
                    "reason": "last_10_scores_all_ge_threshold",
                    "threshold": float(ANOMALY_THRESHOLD),
                    "scores": [float(s) for s in last_scores],
                },
            )
        )
        emitted += 1
        log.info(
            "score_anomaly_flagged",
            user_id=str(user_id),
            scores=[float(s) for s in last_scores],
        )

    db.commit()
    return emitted


@celery_app.task(name="fraud.score_anomaly_scan")
def score_anomaly_scan() -> dict:
    now = datetime.now(UTC)
    with Session(_engine, future=True) as db:
        emitted = _scan(db, now)
    return {"status": "ok", "signals_emitted": emitted, "ran_at": now.isoformat()}
