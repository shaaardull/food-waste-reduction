import asyncio
import os
from typing import AsyncIterator

import pytest
import pytest_asyncio

os.environ.setdefault("NODE_ENV", "test")
os.environ.setdefault("JWT_SECRET", "test_secret_test_secret_test_secret_test_x")


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture
async def client() -> AsyncIterator:
    """In-memory ASGI client for the API. Requires a working database
    when hitting endpoints that touch the DB.
    """
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
