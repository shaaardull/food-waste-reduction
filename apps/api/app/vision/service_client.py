"""Thin sync HTTP client for the standalone services/vision microservice.

Used by the Celery scoring task when settings.USE_VISION_SERVICE is true.
Returns the same shape as the inline Anthropic client so the rest of the
pipeline doesn't care which one ran.
"""
from __future__ import annotations

import time
from typing import Any

import httpx

from app.config import get_settings
from app.errors import ModelUnavailable

settings = get_settings()


def infer_via_service(
    before_image_url: str,
    after_image_url: str,
    expected_dishes: list[dict[str, str]],
) -> tuple[dict[str, Any], int, str]:
    """POST to services/vision/infer with signed URLs.

    Returns (parsed_payload, processing_ms, backend_version_string) — the
    same triple as vision.anthropic_client.score_images, so callers can
    swap clients without re-mapping fields.
    """
    body = {
        "before_image_url": before_image_url,
        "after_image_url": after_image_url,
        "expected_dishes": expected_dishes,
    }
    start = time.perf_counter()
    try:
        res = httpx.post(
            f"{settings.VISION_SERVICE_URL}/infer",
            json=body,
            timeout=settings.VISION_SERVICE_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        raise ModelUnavailable() from exc
    processing_ms = int((time.perf_counter() - start) * 1000)
    if res.status_code != 200:
        raise ModelUnavailable()
    payload = res.json()
    # Re-shape into the Anthropic-style tool output the rest of the
    # pipeline expects (per_item, overall_consumption, confidence, ...).
    parsed = {
        "overall_consumption": payload["overall_consumption"],
        "per_item": payload.get("per_item", []),
        "confidence": payload.get("confidence", 0.0),
        "notes": payload.get("notes", ""),
        "suspicious": payload.get("suspicious", False),
    }
    backend = payload.get("backend", "service")
    backend_version = payload.get("backend_version", "0")
    model_version = f"{backend}:{backend_version}"
    return parsed, processing_ms, model_version
