"""Daily Celery task that purges old plate-capture image objects from S3.

Ethics rule 6 (CLAUDE.md §8): "Default: 7 days. Configurable per user up to
90 days for those who opt in. Celery cron runs nightly to purge expired
image objects from S3 and clear the `image_s3_key` field."

Idempotent — only touches captures whose `image_s3_key IS NOT NULL`. After
the S3 object is deleted the column is cleared, so a re-run is cheap.
"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.celery_app import celery_app
from app.config import get_settings
from app.logging import get_logger
from app.models.meal_session import MealSession
from app.models.plate_capture import PlateCapture
from app.models.user import User
from app.services import storage

log = get_logger(__name__)
settings = get_settings()

_engine = create_engine(settings.DATABASE_URL_SYNC, pool_pre_ping=True, future=True)

# Reasonable per-run cap so a backlog doesn't make one nightly invocation
# wedge for hours. Captures we don't get to today get picked up tomorrow.
MAX_DELETIONS_PER_RUN = 5000


def _scan(db: Session, now: datetime) -> int:
    """Find captures whose age (in seconds) exceeds the owning diner's
    image_retention_days * 86400 and whose image_s3_key is still set,
    delete the S3 object, and null the column. Returns count purged.
    """
    # image_retention_days is NOT NULL with a server_default of 7, so it's
    # always populated. Multiply by 86400 to get the cutoff in seconds.
    cutoff_seconds_expr = User.image_retention_days * 86400
    age_seconds_expr = func.extract("epoch", now - PlateCapture.captured_at)

    rows = list(
        db.execute(
            select(PlateCapture, User.image_retention_days)
            .join(MealSession, MealSession.id == PlateCapture.meal_session_id)
            .join(User, User.id == MealSession.diner_user_id)
            .where(
                PlateCapture.image_s3_key.is_not(None),
                age_seconds_expr > cutoff_seconds_expr,
            )
            .order_by(PlateCapture.captured_at.asc())
            .limit(MAX_DELETIONS_PER_RUN)
        )
    )

    purged = 0
    for capture, retention_days in rows:
        try:
            storage.delete(capture.image_s3_key)
        except Exception as exc:  # noqa: BLE001
            # Don't let one S3 hiccup block the rest of the batch. The
            # capture row will retry on the next run because we only
            # null image_s3_key on success.
            log.warning(
                "image_retention_delete_failed",
                capture_id=str(capture.id),
                key=capture.image_s3_key,
                error=str(exc),
            )
            continue
        capture.image_s3_key = None
        purged += 1
        log.info(
            "image_retention_purged",
            capture_id=str(capture.id),
            retention_days=retention_days,
            age_seconds=int((now - capture.captured_at).total_seconds()),
        )

    db.commit()
    return purged


@celery_app.task(name="image_retention.purge_expired_captures")
def purge_expired_captures() -> dict:
    now = datetime.now(UTC)
    with Session(_engine, future=True) as db:
        purged = _scan(db, now)
    log.info("image_retention_run_complete", purged=purged, ran_at=now.isoformat())
    return {"status": "ok", "purged": purged, "ran_at": now.isoformat()}
