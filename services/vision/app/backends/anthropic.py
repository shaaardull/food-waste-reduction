"""Anthropic / Claude vision backend.

A near-1:1 port of apps/api/app/vision/anthropic_client.py from Phase 1.
Lives here so Phase 1 traffic can be migrated to the microservice without
behaviour change. Selected via VISION_BACKEND=anthropic.
"""
from __future__ import annotations

import base64
import time
from typing import Any

import anthropic

from app.backends.base import Backend, BackendUnavailable
from app.config import get_settings
from app.schemas import ExpectedDish, InferOut, PerItem

_settings = get_settings()

SYSTEM_PROMPT = """\
You are analyzing two photos of a restaurant plate.
- Image 1 was taken BEFORE the meal (food as served).
- Image 2 was taken AFTER the meal (what remains).

Your task: estimate the fraction of food consumed.

Rules:
- Distinguish edible food remaining from non-edible residue (bones, shells, peels, sauce smears).
- Report per-dish consumption when possible; otherwise an overall figure.
- Confidence reflects image quality, occlusion, and ambiguity, not your model's general capability.
- Set "suspicious" true if the after-image is clearly a different plate, location, or scene.
- Be conservative on dish identification: if the after-image is too blurry or off-angle to be sure,
  lower confidence rather than guessing.

Return only the report_consumption tool call.
"""

TOOL_DEFINITION = {
    "name": "report_consumption",
    "description": "Report per-dish consumption analysis from before/after plate images.",
    "input_schema": {
        "type": "object",
        "required": ["overall_consumption", "per_item", "confidence", "notes"],
        "properties": {
            "overall_consumption": {"type": "number", "minimum": 0, "maximum": 1},
            "per_item": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["dish_name", "consumption", "confidence"],
                    "properties": {
                        "dish_name": {"type": "string"},
                        "consumption": {"type": "number", "minimum": 0, "maximum": 1},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    },
                },
            },
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "notes": {"type": "string"},
            "suspicious": {"type": "boolean"},
        },
    },
}


def _image_block(image_bytes: bytes, mime: str) -> dict[str, Any]:
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": mime,
            "data": base64.standard_b64encode(image_bytes).decode("ascii"),
        },
    }


class AnthropicBackend(Backend):
    name = "claude-vision"

    def __init__(self) -> None:
        if not _settings.ANTHROPIC_API_KEY:
            raise BackendUnavailable(
                "ANTHROPIC_API_KEY is required for the anthropic backend"
            )
        self._client = anthropic.Anthropic(
            api_key=_settings.ANTHROPIC_API_KEY,
            timeout=_settings.VISION_TIMEOUT_SECONDS,
        )
        self.version = _settings.VISION_MODEL

    def infer(
        self,
        before_image: bytes,
        before_mime: str,
        after_image: bytes,
        after_mime: str,
        expected_dishes: list[ExpectedDish],
    ) -> InferOut:
        ordered_items_text = "\n".join(
            f"- {d.name}" + (f" ({d.portion_size})" if d.portion_size else "")
            for d in expected_dishes
        ) or "(no items declared)"

        start = time.perf_counter()
        try:
            response = self._client.messages.create(
                model=_settings.VISION_MODEL,
                max_tokens=1024,
                system=SYSTEM_PROMPT,
                tools=[TOOL_DEFINITION],
                tool_choice={"type": "tool", "name": "report_consumption"},
                messages=[
                    {
                        "role": "user",
                        "content": [
                            _image_block(before_image, before_mime),
                            _image_block(after_image, after_mime),
                            {
                                "type": "text",
                                "text": f"The ordered items are:\n{ordered_items_text}",
                            },
                        ],
                    }
                ],
            )
        except anthropic.APIError as exc:
            raise BackendUnavailable(str(exc)) from exc
        processing_ms = int((time.perf_counter() - start) * 1000)

        tool_use = next(
            (b for b in response.content if getattr(b, "type", "") == "tool_use"),
            None,
        )
        if tool_use is None:
            raise BackendUnavailable("Claude did not return a tool_use block")

        payload = tool_use.input
        per_item = [
            PerItem(
                dish_name=item["dish_name"],
                consumption=float(item["consumption"]),
                confidence=float(item["confidence"]),
            )
            for item in payload.get("per_item", [])
        ]
        return InferOut(
            overall_consumption=float(payload.get("overall_consumption", 0.0)),
            per_item=per_item,
            confidence=float(payload.get("confidence", 0.0)),
            notes=str(payload.get("notes", "")),
            suspicious=bool(payload.get("suspicious", False)),
            backend=self.name,
            backend_version=response.model,
            processing_ms=processing_ms,
        )
