"""Weekly Celery task that snapshots per-staff validation metrics and raises an
alert when a staff member's rejection rate has exceeded 2× the restaurant
median for four consecutive weeks.

Ethics rule 8 (CLAUDE.md §8): catches staff who routinely deny rewards
(cost-saving abuse) or routinely approve everything regardless of model score
(favoritism / friend collusion).
"""
from __future__ import annotations

import statistics
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.celery_app import celery_app
from app.config import get_settings
from app.logging import get_logger
from app.models.fraud_signal import FraudSignal
from app.models.staff_metrics import StaffMetricsSnapshot
from app.models.staff_validation import StaffValidation

log = get_logger(__name__)
settings = get_settings()

_engine = create_engine(settings.DATABASE_URL_SYNC, pool_pre_ping=True, future=True)

ALERT_MULTIPLIER = Decimal("2")
ALERT_CONSECUTIVE_WEEKS = 4
# Only consider a staff member's snapshot in the alert decision if they had at
# least this many validations in the week — otherwise rejection_rate is noisy.
MIN_VALIDATIONS_FOR_ALERT = 5


def _week_window(now: datetime) -> tuple[datetime, datetime]:
    """Return the [period_start, period_end) for the week that ENDED at `now`'s
    UTC midnight. So if called Monday 2026-05-25 00:00:01, returns the window
    starting 2026-05-18 00:00:00 and ending 2026-05-25 00:00:00."""
    end = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start = end - timedelta(days=7)
    return start, end


def _compute_week(db: Session, period_start: datetime, period_end: datetime) -> int:
    """Build snapshots for every (staff, restaurant) that had ≥ 1 validation
    in the window. Returns the number of snapshots written."""
    rows = list(
        db.execute(
            select(
                StaffValidation.staff_user_id,
                StaffValidation.restaurant_id,
                StaffValidation.decision,
            ).where(
                StaffValidation.decided_at >= period_start,
                StaffValidation.decided_at < period_end,
            )
        )
    )
    if not rows:
        return 0

    # Aggregate counts per (staff, restaurant).
    counts: dict[tuple[UUID, UUID], dict[str, int]] = {}
    for staff_id, restaurant_id, decision in rows:
        key = (staff_id, restaurant_id)
        bucket = counts.setdefault(
            key, {"approved": 0, "rejected": 0, "adjusted": 0, "total": 0}
        )
        bucket[decision] = bucket.get(decision, 0) + 1
        bucket["total"] += 1

    # Restaurant-wide median rejection rate.
    by_restaurant: dict[UUID, list[Decimal]] = {}
    for (_, restaurant_id), bucket in counts.items():
        rate = (
            Decimal(bucket["rejected"]) / Decimal(bucket["total"])
            if bucket["total"] > 0
            else Decimal(0)
        )
        by_restaurant.setdefault(restaurant_id, []).append(rate)

    restaurant_medians: dict[UUID, Decimal] = {
        rid: Decimal(str(statistics.median([float(r) for r in rates])))
        for rid, rates in by_restaurant.items()
    }

    written = 0
    for (staff_id, restaurant_id), bucket in counts.items():
        approvals = bucket.get("approved", 0)
        rejections = bucket.get("rejected", 0)
        adjustments = bucket.get("adjusted", 0)
        total = bucket["total"]
        rejection_rate = Decimal(rejections) / Decimal(total) if total else Decimal(0)
        approval_rate = Decimal(approvals) / Decimal(total) if total else Decimal(0)

        # Upsert idempotently — same (staff, period_start) is the unique key.
        existing = db.execute(
            select(StaffMetricsSnapshot).where(
                StaffMetricsSnapshot.staff_user_id == staff_id,
                StaffMetricsSnapshot.period_start == period_start,
            )
        ).scalar_one_or_none()
        median = restaurant_medians.get(restaurant_id, Decimal(0))
        if existing is None:
            db.add(
                StaffMetricsSnapshot(
                    staff_user_id=staff_id,
                    restaurant_id=restaurant_id,
                    period_start=period_start,
                    period_end=period_end,
                    validations_count=total,
                    approvals_count=approvals,
                    rejections_count=rejections,
                    adjustments_count=adjustments,
                    rejection_rate=rejection_rate,
                    approval_rate=approval_rate,
                    restaurant_median_rejection_rate=median,
                )
            )
        else:
            existing.validations_count = total
            existing.approvals_count = approvals
            existing.rejections_count = rejections
            existing.adjustments_count = adjustments
            existing.rejection_rate = rejection_rate
            existing.approval_rate = approval_rate
            existing.restaurant_median_rejection_rate = median
        written += 1
    db.flush()
    return written


def _check_alerts(db: Session, latest_period_start: datetime) -> int:
    """Look at the latest 4 snapshots per staff. If all four are
    consecutive weekly periods AND every one has rejection_rate > 2× median
    (with at least MIN_VALIDATIONS_FOR_ALERT validations), emit a fraud_signal."""
    earliest = latest_period_start - timedelta(weeks=ALERT_CONSECUTIVE_WEEKS - 1)
    rows = list(
        db.execute(
            select(StaffMetricsSnapshot)
            .where(StaffMetricsSnapshot.period_start >= earliest)
            .order_by(
                StaffMetricsSnapshot.staff_user_id, StaffMetricsSnapshot.period_start
            )
        ).scalars()
    )
    by_staff: dict[UUID, list[StaffMetricsSnapshot]] = {}
    for snap in rows:
        by_staff.setdefault(snap.staff_user_id, []).append(snap)

    emitted = 0
    for staff_id, snaps in by_staff.items():
        if len(snaps) < ALERT_CONSECUTIVE_WEEKS:
            continue
        recent = snaps[-ALERT_CONSECUTIVE_WEEKS:]
        # Periods must be consecutive weeks.
        consecutive = all(
            (recent[i].period_start - recent[i - 1].period_start).days == 7
            for i in range(1, ALERT_CONSECUTIVE_WEEKS)
        )
        if not consecutive:
            continue
        if not all(snap.validations_count >= MIN_VALIDATIONS_FOR_ALERT for snap in recent):
            continue
        if not all(
            snap.rejection_rate
            > ALERT_MULTIPLIER * snap.restaurant_median_rejection_rate
            for snap in recent
        ):
            continue

        # Don't double-alert within the same week.
        already = db.execute(
            select(FraudSignal.id).where(
                FraudSignal.user_id == staff_id,
                FraudSignal.signal_type == "manual_flag",
                FraudSignal.created_at >= latest_period_start,
            )
        ).first()
        if already:
            continue
        db.add(
            FraudSignal(
                user_id=staff_id,
                signal_type="manual_flag",
                severity="warning",
                details={
                    "reason": "staff_rejection_rate_2x_median_4_weeks",
                    "rates": [float(s.rejection_rate) for s in recent],
                    "restaurant_medians": [
                        float(s.restaurant_median_rejection_rate) for s in recent
                    ],
                    "validations_counts": [s.validations_count for s in recent],
                    "restaurant_id": str(recent[-1].restaurant_id),
                },
            )
        )
        emitted += 1
        log.info(
            "staff_metrics_alert",
            staff_user_id=str(staff_id),
            rates=[float(s.rejection_rate) for s in recent],
        )
    return emitted


@celery_app.task(name="metrics.staff_metrics_weekly")
def staff_metrics_weekly() -> dict:
    now = datetime.now(UTC)
    period_start, period_end = _week_window(now)
    with Session(_engine, future=True) as db:
        written = _compute_week(db, period_start, period_end)
        alerts = _check_alerts(db, period_start)
        db.commit()
    log.info(
        "staff_metrics_weekly_complete",
        period_start=period_start.isoformat(),
        snapshots=written,
        alerts=alerts,
    )
    return {
        "status": "ok",
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "snapshots_written": written,
        "alerts_emitted": alerts,
    }
