"""Celery task that scores a meal session using the vision model.

The task is synchronous (sync SQLAlchemy) on purpose — Celery workers run a
thread/process per task and we don't want to mix the asyncio loop here.
"""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

import yaml
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.celery_app import celery_app
from app.config import get_settings
from app.logging import get_logger
from app.models.consumption_score import ConsumptionScore
from app.models.fraud_signal import FraudSignal
from app.models.meal_session import MealSession, MealSessionItem
from app.models.menu_item import MenuItem
from app.models.plate_capture import PlateCapture
from app.services import storage
from app.vision.anthropic_client import score_images

log = get_logger(__name__)
settings = get_settings()

_engine = create_engine(settings.DATABASE_URL_SYNC, pool_pre_ping=True, future=True)


def _ordered_items_yaml(db: Session, session_id: UUID) -> str:
    rows = db.execute(
        select(MealSessionItem, MenuItem)
        .join(MenuItem, MealSessionItem.menu_item_id == MenuItem.id)
        .where(MealSessionItem.meal_session_id == session_id)
    ).all()
    data = [
        {
            "name": menu.name,
            "quantity": item.quantity,
            "portion_size": item.portion_size or "regular",
            "category": menu.category,
        }
        for item, menu in rows
    ]
    return yaml.safe_dump(data, sort_keys=False)


@celery_app.task(name="vision.score_meal_session", bind=True, max_retries=2, default_retry_delay=15)
def score_meal_session(self, session_id_str: str) -> dict:  # noqa: ANN001
    session_id = UUID(session_id_str)
    log.info("score_task_started", session_id=session_id_str)
    with Session(_engine, future=True) as db:
        session = db.get(MealSession, session_id)
        if session is None:
            log.warning("score_task_session_missing", session_id=session_id_str)
            return {"status": "missing"}

        if session.status not in ("after_submitted", "pending_staff_validation"):
            log.info("score_task_skip", status=session.status, session_id=session_id_str)
            return {"status": "skipped", "session_status": session.status}

        captures = {
            c.phase: c
            for c in db.execute(
                select(PlateCapture).where(PlateCapture.meal_session_id == session.id)
            ).scalars()
        }
        if "before" not in captures or "after" not in captures:
            log.warning("score_task_missing_captures", session_id=session_id_str)
            return {"status": "incomplete_captures"}

        before_bytes = storage.download(captures["before"].image_s3_key)
        after_bytes = storage.download(captures["after"].image_s3_key)
        before_mime = "image/jpeg" if captures["before"].image_s3_key.endswith(".jpg") else "image/png"
        after_mime = "image/jpeg" if captures["after"].image_s3_key.endswith(".jpg") else "image/png"

        ordered_items_yaml = _ordered_items_yaml(db, session.id)

        try:
            result, processing_ms, model_version = score_images(
                before_bytes, before_mime, after_bytes, after_mime, ordered_items_yaml
            )
        except Exception as exc:  # noqa: BLE001
            log.error("score_task_failed", error=str(exc), session_id=session_id_str)
            raise self.retry(exc=exc)

        overall = float(result.get("overall_consumption", 0.0))
        confidence = float(result.get("confidence", 0.0))
        suspicious = bool(result.get("suspicious", False))

        score = ConsumptionScore(
            meal_session_id=session.id,
            overall_score=overall,
            per_item_scores=result.get("per_item", []),
            model_name="claude-vision",
            model_version=model_version,
            processing_ms=processing_ms,
            raw_model_output=result,
            notes=result.get("notes"),
            suspicious=suspicious,
            confidence=confidence,
        )
        db.add(score)

        if suspicious:
            db.add(
                FraudSignal(
                    meal_session_id=session.id,
                    user_id=session.diner_user_id,
                    signal_type="manual_flag",
                    severity="block",
                    details={
                        "reason": "model_flagged_suspicious",
                        "model_notes": result.get("notes"),
                    },
                )
            )

        session.status = "pending_staff_validation"
        session.updated_at = datetime.now(timezone.utc)
        db.commit()

    log.info(
        "score_task_done",
        session_id=session_id_str,
        overall=overall,
        confidence=confidence,
        suspicious=suspicious,
    )
    return {"status": "ok", "overall": overall, "confidence": confidence, "suspicious": suspicious}
