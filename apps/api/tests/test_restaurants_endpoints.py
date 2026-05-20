"""Integration tests for /api/v1/restaurants (CLAUDE.md §5.2)."""
from __future__ import annotations

import pytest

from tests.conftest import make_restaurant


@pytest.mark.asyncio
async def test_list_restaurants_includes_test_fixture(client, db):
    restaurant, _, _ = make_restaurant(db, name="Test List Spot")
    res = await client.get("/api/v1/restaurants")
    assert res.status_code == 200
    body = res.json()
    ids = [r["id"] for r in body]
    assert str(restaurant.id) in ids


@pytest.mark.asyncio
async def test_list_restaurants_geofilter(client, db):
    near, _, _ = make_restaurant(db, name="Nearby", lat=19.06, lng=72.83)
    far, _, _ = make_restaurant(db, name="Faraway", lat=28.61, lng=77.21)
    # 50km around the Nearby latitude — should include `near`, exclude `far`.
    res = await client.get(
        "/api/v1/restaurants", params={"lat": 19.06, "lng": 72.83, "radius_km": 50}
    )
    assert res.status_code == 200
    ids = [r["id"] for r in res.json()]
    assert str(near.id) in ids
    assert str(far.id) not in ids


@pytest.mark.asyncio
async def test_get_restaurant_by_slug(client, db):
    restaurant, _, _ = make_restaurant(db, name="Slug Spot")
    res = await client.get(f"/api/v1/restaurants/{restaurant.slug}")
    assert res.status_code == 200
    assert res.json()["slug"] == restaurant.slug


@pytest.mark.asyncio
async def test_get_restaurant_by_unknown_slug_returns_404(client):
    res = await client.get("/api/v1/restaurants/does-not-exist-itest")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_get_menu_returns_active_items(client, db):
    restaurant, items, _ = make_restaurant(db, name="Menu Spot")
    res = await client.get(f"/api/v1/restaurants/{restaurant.id}/menu")
    assert res.status_code == 200
    names = [m["name"] for m in res.json()]
    for item in items:
        assert item.name in names


@pytest.mark.asyncio
async def test_health(client):
    res = await client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert "version" in body
