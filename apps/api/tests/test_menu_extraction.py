"""Tests for POST /restaurants/:id/menu-items/extract — the vision-based
menu-card import.

The real Anthropic call is monkeypatched with a canned tool_use payload;
we assert the endpoint's coerce / clamp / log-to-menu_extractions
behaviour, plus the same role gates as the CRUD endpoints.

An integration test against the real model belongs behind a
`--run-live-vision` flag; that costs money and needs the ANTHROPIC_API_KEY
so it stays out of the default CI matrix.
"""
from __future__ import annotations

from io import BytesIO
from typing import Any

import pytest
from PIL import Image
from sqlalchemy import select

from app.models.menu_extraction import MenuExtraction
from tests.conftest import (
    login,
    make_restaurant,
    make_staff,
    register_diner,
)


def _fake_extract(
    *,
    items: list[dict[str, Any]] | None = None,
    currency: str = "INR",
    confidence: float = 0.88,
    notes: str = "",
    processing_ms: int = 1200,
    model_version: str = "claude-sonnet-4-5-20250929",
):
    """Build a stand-in for anthropic_client.extract_menu_from_image.
    The endpoint code only reads .items[], .detected_currency, etc.,
    so the tool_input dict is all we need to return."""

    def _impl(image_bytes: bytes, image_mime: str):
        return (
            {
                "items": items
                or [
                    {
                        "name": "Butter Chicken",
                        "description": "Tandoor chicken in tomato-cream gravy",
                        "price_minor": 32000,
                        "category": "main",
                        "confidence": 0.94,
                    },
                    {
                        "name": "Garlic Naan",
                        "price_minor": 8000,
                        "category": "bread",
                        "confidence": 0.9,
                    },
                    {
                        "name": "Gulab Jamun",
                        "price_minor": 12000,
                        "category": "dessert",
                        "confidence": 0.6,  # low-confidence row
                    },
                ],
                "detected_currency": currency,
                "confidence": confidence,
                "notes": notes,
            },
            processing_ms,
            model_version,
        )

    return _impl


def _png_bytes(size: int = 32) -> bytes:
    """A tiny valid PNG — validate_and_hash requires a real image."""
    img = Image.new("RGB", (size, size), color=(180, 120, 90))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_extract_menu_returns_proposed_items(
    client, db, monkeypatch
):
    from app.routers import restaurants as restaurants_router

    monkeypatch.setattr(
        restaurants_router.vision_client,
        "extract_menu_from_image",
        _fake_extract(),
    )
    # MinIO/S3 upload is a real network side-effect in dev; short-circuit
    # so this test can run on CI without an object store.
    monkeypatch.setattr(
        restaurants_router.storage,
        "upload_menu_extraction",
        lambda extraction_id, image_bytes, mime: (
            f"menu-extractions/{extraction_id}/source.png"
        ),
    )

    restaurant, _, _ = make_restaurant(db, name="Extract Basic")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)

    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/extract",
        files={"image": ("menu.png", _png_bytes(), "image/png")},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["detected_currency"] == "INR"
    assert body["processing_ms"] == 1200
    assert len(body["items"]) == 3
    names = [i["name"] for i in body["items"]]
    assert "Butter Chicken" in names
    # Low-confidence row is preserved, not dropped — staff review is the
    # place where it gets filtered.
    low = next(i for i in body["items"] if i["name"] == "Gulab Jamun")
    assert low["confidence"] < 0.75


@pytest.mark.asyncio
async def test_extract_menu_logs_audit_row(client, db, monkeypatch):
    from app.routers import restaurants as restaurants_router

    monkeypatch.setattr(
        restaurants_router.vision_client,
        "extract_menu_from_image",
        _fake_extract(),
    )
    monkeypatch.setattr(
        restaurants_router.storage,
        "upload_menu_extraction",
        lambda extraction_id, image_bytes, mime: (
            f"menu-extractions/{extraction_id}/source.png"
        ),
    )

    restaurant, _, _ = make_restaurant(db, name="Extract Audit")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)

    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/extract",
        files={"image": ("menu.png", _png_bytes(), "image/png")},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    extraction_id = res.json()["extraction_id"]

    row = db.execute(
        select(MenuExtraction).where(MenuExtraction.id == extraction_id)
    ).scalar_one()
    assert row.restaurant_id == restaurant.id
    assert row.staff_user_id == manager.id
    assert row.items_proposed == 3
    assert row.items_accepted == 0  # updated on the follow-up bulk-add
    assert row.raw_output["detected_currency"] == "INR"
    assert row.processing_ms == 1200
    assert row.image_s3_key.startswith("menu-extractions/")


@pytest.mark.asyncio
async def test_extract_menu_coerces_invalid_category_to_null(
    client, db, monkeypatch
):
    """The model can hallucinate a category outside the enum. The server
    must coerce it to None so staff picks; it must never poison the
    response body with an unknown value."""
    from app.routers import restaurants as restaurants_router

    monkeypatch.setattr(
        restaurants_router.vision_client,
        "extract_menu_from_image",
        _fake_extract(
            items=[
                {
                    "name": "Mystery Item",
                    "price_minor": 10000,
                    "category": "appetizer",  # NOT in enum
                    "confidence": 0.7,
                }
            ]
        ),
    )
    monkeypatch.setattr(
        restaurants_router.storage,
        "upload_menu_extraction",
        lambda extraction_id, image_bytes, mime: (
            f"menu-extractions/{extraction_id}/source.png"
        ),
    )

    restaurant, _, _ = make_restaurant(db, name="Extract Bad Category")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)

    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/extract",
        files={"image": ("menu.png", _png_bytes(), "image/png")},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["items"][0]["category"] is None


@pytest.mark.asyncio
async def test_extract_menu_skips_nameless_row(client, db, monkeypatch):
    """A row without a `name` is unusable — filter it out silently so
    the frontend doesn't render blank cards."""
    from app.routers import restaurants as restaurants_router

    monkeypatch.setattr(
        restaurants_router.vision_client,
        "extract_menu_from_image",
        _fake_extract(
            items=[
                {
                    "name": "  ",  # whitespace only
                    "price_minor": 12000,
                    "category": "main",
                    "confidence": 0.9,
                },
                {
                    "name": "Real Dish",
                    "price_minor": 12000,
                    "category": "main",
                    "confidence": 0.9,
                },
            ]
        ),
    )
    monkeypatch.setattr(
        restaurants_router.storage,
        "upload_menu_extraction",
        lambda extraction_id, image_bytes, mime: (
            f"menu-extractions/{extraction_id}/source.png"
        ),
    )

    restaurant, _, _ = make_restaurant(db, name="Extract Nameless")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)

    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/extract",
        files={"image": ("menu.png", _png_bytes(), "image/png")},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    body = res.json()
    assert len(body["items"]) == 1
    assert body["items"][0]["name"] == "Real Dish"


@pytest.mark.asyncio
async def test_extract_menu_diner_blocked(client, db):
    restaurant, _, _ = make_restaurant(db, name="Extract Diner Blocked")
    _, diner_token = await register_diner(client)
    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/extract",
        files={"image": ("menu.png", _png_bytes(), "image/png")},
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_extract_menu_cross_restaurant_blocked(client, db):
    r_a, _, _ = make_restaurant(db, name="Cross A")
    r_b, _, _ = make_restaurant(db, name="Cross B")
    staff_b = make_staff(db, r_b.id)
    token = await login(client, staff_b.email)
    res = await client.post(
        f"/api/v1/restaurants/{r_a.id}/menu-items/extract",
        files={"image": ("menu.png", _png_bytes(), "image/png")},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_extract_menu_rejects_non_image(client, db, monkeypatch):
    """validate_and_hash raises ImageInvalid on non-image bytes — verify
    the response is a 4xx and the vision client is never called."""
    from app.routers import restaurants as restaurants_router

    called = {"n": 0}

    def _boom(*args, **kwargs):
        called["n"] += 1
        raise AssertionError("vision client called on bad upload")

    monkeypatch.setattr(
        restaurants_router.vision_client, "extract_menu_from_image", _boom
    )

    restaurant, _, _ = make_restaurant(db, name="Extract Bad Bytes")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)

    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/extract",
        files={"image": ("menu.txt", b"not an image", "text/plain")},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert 400 <= res.status_code < 500, res.text
    assert called["n"] == 0
