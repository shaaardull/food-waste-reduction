import base64
import time
from typing import Any

import anthropic

from app.config import get_settings
from app.errors import ModelUnavailable
from app.logging import get_logger
from app.vision.prompts import SYSTEM_PROMPT, TOOL_DEFINITION, build_user_prompt

log = get_logger(__name__)
settings = get_settings()


def _client() -> anthropic.Anthropic:
    if not settings.ANTHROPIC_API_KEY:
        raise ModelUnavailable()
    return anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY, timeout=settings.VISION_TIMEOUT_SECONDS)


def _image_block(image_bytes: bytes, mime: str) -> dict[str, Any]:
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": mime,
            "data": base64.standard_b64encode(image_bytes).decode("ascii"),
        },
    }


def score_images(
    before_image: bytes,
    before_mime: str,
    after_image: bytes,
    after_mime: str,
    ordered_items_yaml: str,
) -> tuple[dict[str, Any], int, str]:
    """Calls Claude with both images and the tool definition.

    Returns (parsed_tool_input, processing_ms, model_version_string).
    """
    client = _client()
    start = time.perf_counter()
    try:
        response = client.messages.create(
            model=settings.VISION_MODEL,
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
                        {"type": "text", "text": build_user_prompt(ordered_items_yaml)},
                    ],
                }
            ],
        )
    except anthropic.APIError as exc:
        log.error("anthropic_api_error", error=str(exc))
        raise ModelUnavailable() from exc
    processing_ms = int((time.perf_counter() - start) * 1000)

    tool_use = next(
        (block for block in response.content if getattr(block, "type", "") == "tool_use"),
        None,
    )
    if tool_use is None:
        log.error("anthropic_no_tool_use", model=settings.VISION_MODEL)
        raise ModelUnavailable()
    return tool_use.input, processing_ms, response.model
