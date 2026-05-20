"""Tests for the vision service.

Uses the StubBackend (set via VISION_BACKEND=stub in conftest) so tests
don't need an Anthropic key or a real model. Image fetching is monkey-
patched so we don't actually open HTTP connections.
"""
from __future__ import annotations

import pytest

from tests.conftest import png_bytes


@pytest.mark.asyncio
async def test_health(client):
    res = await client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["backend"] == "stub"


@pytest.mark.asyncio
async def test_infer_uses_stub_backend(client, monkeypatch):
    async def fake_fetch(_url):
        return png_bytes(), "image/png"

    from app import main

    monkeypatch.setattr(main, "fetch_image", fake_fetch)

    res = await client.post(
        "/infer",
        json={
            "before_image_url": "https://example.test/before.png",
            "after_image_url": "https://example.test/after.png",
            "expected_dishes": [
                {"name": "Butter Chicken", "portion_size": "regular"},
                {"name": "Naan", "portion_size": "small"},
            ],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["backend"] == "stub"
    assert body["overall_consumption"] == 0.8
    assert len(body["per_item"]) == 2
    assert body["per_item"][0]["dish_name"] == "Butter Chicken"


@pytest.mark.asyncio
async def test_infer_400_on_unfetchable_image(client, monkeypatch):
    async def bad_fetch(_url):
        raise ValueError("unrecognized image format")

    from app import main

    monkeypatch.setattr(main, "fetch_image", bad_fetch)
    res = await client.post(
        "/infer",
        json={
            "before_image_url": "https://example.test/before.png",
            "after_image_url": "https://example.test/after.png",
            "expected_dishes": [],
        },
    )
    assert res.status_code == 400
    body = res.json()["detail"]
    assert body["error"]["code"] == "IMAGE_INVALID"


@pytest.mark.asyncio
async def test_infer_503_when_backend_unavailable(client, monkeypatch):
    """Force the factory to return a backend that raises BackendUnavailable."""

    from app import main
    from app.backends.base import Backend, BackendUnavailable

    async def fake_fetch(_url):
        return png_bytes(), "image/png"

    monkeypatch.setattr(main, "fetch_image", fake_fetch)

    class BoomBackend(Backend):
        name = "boom"
        version = "0"

        def infer(self, *args, **kwargs):  # noqa: ANN001
            raise BackendUnavailable("model service down")

    monkeypatch.setattr(main, "get_backend", lambda: BoomBackend())

    res = await client.post(
        "/infer",
        json={
            "before_image_url": "https://example.test/before.png",
            "after_image_url": "https://example.test/after.png",
            "expected_dishes": [],
        },
    )
    assert res.status_code == 503
    body = res.json()
    assert body["error"]["code"] == "MODEL_UNAVAILABLE"
