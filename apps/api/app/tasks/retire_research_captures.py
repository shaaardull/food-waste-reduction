"""Retire a user's historic plate_captures from research use.

Fires when a diner flips their Research Consent from accepted to
withdrawn (see routers/consents.py: toggle_research_consent). Sets
plate_captures.research_consent_at_capture = FALSE for every capture
owned by the user, so the partial index and subsequent training-data
queries stop including them.

Per Research Consent §6.2(c), we cannot un-train a model that has
already learned from this user's data; the point of this task is to
prevent future training runs from pulling their data.

Idempotent — if a capture is already marked FALSE, the UPDATE is a
no-op. Safe to re-run.
"""
from __future__ import annotations

from sqlalchemy import create_engine, text, update
from sqlalchemy.orm import Session

from app.celery_app import celery_app
from app.config import get_settings
from app.logging import get_logger
from app.models.meal_session import MealSession
from app.models.plate_capture import PlateCapture

log = get_logger(__name__)
settings = get_settings()

_engine = create_engine(settings.DATABASE_URL_SYNC, pool_pre_ping=True, future=True)


@celery_app.task(name="research.retire_captures")
def retire_research_captures(user_id: str) -> dict:
    """Set research_consent_at_capture=FALSE on every capture owned by
    the given user. Returns count updated for observability."""
    with Session(_engine, future=True) as db:
        # Join through meal_sessions to find captures owned by this user.
        # A single UPDATE ... FROM keeps this cheap even for a user with
        # thousands of captures.
        result = db.execute(
            text(
                """
                UPDATE plate_captures
                SET research_consent_at_capture = FALSE
                FROM meal_sessions
                WHERE plate_captures.meal_session_id = meal_sessions.id
                  AND meal_sessions.diner_user_id = :user_id
                  AND plate_captures.research_consent_at_capture = TRUE
                """
            ),
            {"user_id": user_id},
        )
        updated = result.rowcount or 0
        db.commit()

    log.info(
        "research_consent_retired",
        user_id=user_id,
        captures_updated=updated,
    )
    return {"status": "ok", "user_id": user_id, "captures_updated": updated}
