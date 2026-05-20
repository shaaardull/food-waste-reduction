"""Unit tests for app.vision.service_client.infer_via_service.

Uses respx-style monkeypatching of httpx.post; no real HTTP traffic.
"""
from __future__ import annotations

import pytest

from app.errors import ModelUnavailable
from app.vision import service_client


class _Response:
    def __init__(self, status_code: int, payload: dict | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


def test_infer_via_service_returns_anthropic_shape(monkeypatch):
    captured: dict = {}

    def fake_post(url, json, timeout):  # noqa: ANN001
        captured["url"] = url
        captured["json"] = json
        return _Response(
            200,
            {
                "overall_consumption": 0.88,
                "per_item": [
                    {"dish_name": "Butter Chicken", "consumption": 0.9, "confidence": 0.85}
                ],
                "confidence": 0.85,
                "notes": "looks clean",
                "suspicious": False,
                "backend": "stub",
                "backend_version": "1",
                "processing_ms": 12,
            },
        )

    monkeypatch.setattr(service_client.httpx, "post", fake_post)

    parsed, processing_ms, model_version = service_client.infer_via_service(
        "https://s3.test/before.jpg",
        "https://s3.test/after.jpg",
        [{"name": "Butter Chicken", "portion_size": "regular"}],
    )
    assert parsed["overall_consumption"] == 0.88
    assert parsed["per_item"][0]["dish_name"] == "Butter Chicken"
    assert model_version == "stub:1"
    assert processing_ms >= 0
    assert captured["url"].endswith("/infer")
    assert captured["json"]["before_image_url"] == "https://s3.test/before.jpg"


def test_infer_via_service_raises_on_non_200(monkeypatch):
    monkeypatch.setattr(
        service_client.httpx,
        "post",
        lambda *a, **kw: _Response(503, {"error": {"code": "MODEL_UNAVAILABLE"}}),
    )
    with pytest.raises(ModelUnavailable):
        service_client.infer_via_service(
            "https://s3.test/before.jpg",
            "https://s3.test/after.jpg",
            [],
        )


def test_infer_via_service_raises_on_connection_error(monkeypatch):
    import httpx as _httpx

    def boom(*a, **kw):  # noqa: ANN001
        raise _httpx.ConnectError("connection refused")

    monkeypatch.setattr(service_client.httpx, "post", boom)
    with pytest.raises(ModelUnavailable):
        service_client.infer_via_service(
            "https://s3.test/before.jpg",
            "https://s3.test/after.jpg",
            [],
        )
