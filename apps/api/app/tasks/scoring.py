"""Celery task that scores a meal session using the vision model.

The task is synchronous (sync SQLAlchemy) on purpose — Celery workers run a
thread/process per task and we don't want to mix the asyncio loop here.
"""
from __future__ import annotations

from datetime import UTC, datetime
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
from app.services.phash import continuity_check
from app.vision.anthropic_client import score_images
from app.vision.service_client import infer_via_service

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


def _expected_dishes_payload(db: Session, session_id: UUID) -> list[dict[str, str]]:
    """Shape ordered items for the services/vision /infer payload."""
    rows = db.execute(
        select(MealSessionItem, MenuItem)
        .join(MenuItem, MealSessionItem.menu_item_id == MenuItem.id)
        .where(MealSessionItem.meal_session_id == session_id)
    ).all()
    return [
        {
            "name": menu.name,
            "portion_size": item.portion_size or "regular",
            **(
                {"reference_image_url": menu.reference_image_url}
                if menu.reference_image_url
                else {}
            ),
        }
        for item, menu in rows
    ]


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

        # Fraud signal #6: phash continuity between before/after non-food frame.
        try:
            phash = continuity_check(before_bytes, after_bytes)
            if not phash.matched:
                db.add(
                    FraudSignal(
                        meal_session_id=session.id,
                        user_id=session.diner_user_id,
                        signal_type="image_metadata_mismatch",
                        severity="block",
                        details={
                            "reason": "phash_continuity_failed",
                            "hamming_distance": phash.distance,
                            "max_allowed": 8,
                            "before_hash": phash.before_hash,
                            "after_hash": phash.after_hash,
                        },
                    )
                )
                log.warning(
                    "phash_continuity_failed",
                    session_id=session_id_str,
                    distance=phash.distance,
                )
        except Exception as exc:  # noqa: BLE001
            # Don't fail the whole scoring path on a phash hiccup; just log it.
            log.warning("phash_continuity_error", session_id=session_id_str, error=str(exc))

        try:
            if settings.USE_VISION_SERVICE:
                # Phase 2 path: dispatch to services/vision over HTTP, using
                # signed S3 URLs the service can fetch.
                before_url = storage.signed_url(captures["before"].image_s3_key)
                after_url = storage.signed_url(captures["after"].image_s3_key)
                expected_dishes = _expected_dishes_payload(db, session.id)
                result, processing_ms, model_version = infer_via_service(
                    before_url, after_url, expected_dishes
                )
            else:
                # Phase 1 default: inline Anthropic call.
                result, processing_ms, model_version = score_images(
                    before_bytes, before_mime, after_bytes, after_mime, ordered_items_yaml
                )
        except Exception as exc:  # noqa: BLE001
            log.error("score_task_failed", error=str(exc), session_id=session_id_str)
            raise self.retry(exc=exc) from exc

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
        session.updated_at = datetime.now(UTC)
        db.commit()

    log.info(
        "score_task_done",
        session_id=session_id_str,
        overall=overall,
        confidence=confidence,
        suspicious=suspicious,
    )
    return {"status": "ok", "overall": overall, "confidence": confidence, "suspicious": suspicious}
