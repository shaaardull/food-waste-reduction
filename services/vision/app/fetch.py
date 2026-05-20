"""Fetch capture images from signed URLs."""
from __future__ import annotations

import io

import httpx
from PIL import Image, UnidentifiedImageError

from app.config import get_settings

_settings = get_settings()


async def fetch_image(url: str) -> tuple[bytes, str]:
    """Download an image. Returns (bytes, mime_type). Raises ValueError on
    a non-image response or one larger than MAX_IMAGE_BYTES."""
    async with httpx.AsyncClient(timeout=_settings.IMAGE_FETCH_TIMEOUT_SECONDS) as client:
        res = await client.get(url)
    res.raise_for_status()
    body = res.content
    if len(body) > _settings.MAX_IMAGE_BYTES:
        raise ValueError(
            f"image too large: {len(body)} bytes > {_settings.MAX_IMAGE_BYTES}"
        )
    if not body:
        raise ValueError("empty image body")
    try:
        with Image.open(io.BytesIO(body)) as img:
            img.verify()
            fmt = (img.format or "").lower()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ValueError("unrecognized image format") from exc
    if fmt not in {"jpeg", "jpg", "png"}:
        raise ValueError(f"unsupported image format: {fmt}")
    mime = "image/jpeg" if fmt in ("jpeg", "jpg") else "image/png"
    return body, mime
