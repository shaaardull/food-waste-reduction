import io
import os
from collections.abc import AsyncIterator

import pytest_asyncio
from PIL import Image

os.environ.setdefault("VISION_BACKEND", "stub")
os.environ.setdefault("NODE_ENV", "test")


def png_bytes(color: tuple[int, int, int] = (180, 90, 60), size: int = 64) -> bytes:
    img = Image.new("RGB", (size, size), color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest_asyncio.fixture
async def client() -> AsyncIterator:
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
