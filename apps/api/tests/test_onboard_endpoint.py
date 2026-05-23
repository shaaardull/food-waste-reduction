"""Integration tests for POST /api/v1/onboard/restaurant.

Self-service onboarding (CLAUDE.md §9 Phase 2). Verifies:
- Happy path: user + restaurant + owner-membership all land atomically
  and the returned token works for owner-scoped endpoints.
- Owner role is 'staff' on the user, 'owner' on the restaurant_staff row.
- Slug collision returns 409.
- Email collision returns 409.
- Age-confirm required (ethics rule 4).
- The new owner can hit a follow-up owner-scoped endpoint with the
  returned token (proves the JWT carries the right claims).
"""
from __future__ import annotations

import uuid as _uuid

import pytest
from sqlalchemy import select

from app.models.restaurant import Restaurant, RestaurantStaff
from app.models.user import User
from tests.conftest import make_email, make_restaurant, make_slug


def _payload(*, email: str | None = None, slug: str | None = None) -> dict:
    """A minimal valid onboarding body. Caller can override email/slug
    to test collision paths."""
    return {
        "owner": {
            "email": email or make_email("owner"),
            "password": "plate-clean-demo",
            "display_name": "Test Owner",
            "is_adult": True,
        },
        "restaurant": {
            "name": "Test Onboarded Spot",
            "slug": slug or make_slug("onboard"),
            "address": "1 Test Lane, Mumbai",
            "latitude": 19.06,
            "longitude": 72.83,
        },
    }


@pytest.mark.asyncio
async def test_onboard_happy_path(client, db):
    """User created with role=staff, restaurant created, RestaurantStaff
    row pins them as owner. Token returned + works."""
    body = _payload()
    res = await client.post("/api/v1/onboard/restaurant", json=body)
    assert res.status_code == 201, res.text
    out = res.json()

    assert "token" in out
    assert out["user"]["email"] == body["owner"]["email"]
    assert out["user"]["role"] == "staff"
    assert out["restaurant"]["slug"] == body["restaurant"]["slug"]
    assert out["restaurant"]["name"] == "Test Onboarded Spot"

    # Verify the membership row landed and is 'owner'.
    user_id = _uuid.UUID(out["user"]["id"])
    restaurant_id = _uuid.UUID(out["restaurant"]["id"])
    rs = db.execute(
        select(RestaurantStaff).where(
            RestaurantStaff.user_id == user_id,
            RestaurantStaff.restaurant_id == restaurant_id,
        )
    ).scalar_one()
    assert rs.role == "owner"


@pytest.mark.asyncio
async def test_onboard_token_works_for_owner_scoped_endpoint(client, db):
    """The JWT returned from /onboard should let the new user call any
    endpoint gated by _require_owner_or_admin. PATCH /restaurants/:id is
    the canonical example."""
    body = _payload()
    res = await client.post("/api/v1/onboard/restaurant", json=body)
    assert res.status_code == 201
    out = res.json()
    token = out["token"]
    restaurant_id = out["restaurant"]["id"]

    patch_res = await client.patch(
        f"/api/v1/restaurants/{restaurant_id}",
        json={"tagline": "We just signed up!"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert patch_res.status_code == 200, patch_res.text
    assert patch_res.json()["tagline"] == "We just signed up!"


@pytest.mark.asyncio
async def test_onboard_rejects_minor(client, db):
    """is_adult=false → 400 with the same MINOR_NOT_PERMITTED code as
    /auth/register (ethics rule 4)."""
    body = _payload()
    body["owner"]["is_adult"] = False
    res = await client.post("/api/v1/onboard/restaurant", json=body)
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "MINOR_NOT_PERMITTED"


@pytest.mark.asyncio
async def test_onboard_rejects_taken_email(client, db):
    """Email collision returns 409 EMAIL_TAKEN. Doesn't leave a partial
    user/restaurant pair."""
    # Seed an existing user by onboarding once.
    first = _payload()
    res1 = await client.post("/api/v1/onboard/restaurant", json=first)
    assert res1.status_code == 201

    # Try again with the same email but a different slug.
    second = _payload(email=first["owner"]["email"], slug=make_slug("onboard2"))
    res2 = await client.post("/api/v1/onboard/restaurant", json=second)
    assert res2.status_code == 409
    assert res2.json()["error"]["code"] == "EMAIL_TAKEN"

    # Confirm the second restaurant wasn't created.
    rs = db.execute(
        select(Restaurant).where(Restaurant.slug == second["restaurant"]["slug"])
    ).scalar_one_or_none()
    assert rs is None


@pytest.mark.asyncio
async def test_onboard_rejects_taken_slug(client, db):
    """Slug collision returns 409 SLUG_TAKEN. No partial user landed."""
    existing, _, _ = make_restaurant(db, name="Existing Brand")
    body = _payload(slug=existing.slug)
    res = await client.post("/api/v1/onboard/restaurant", json=body)
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "SLUG_TAKEN"

    # The pre-check fires before user creation, so no user row should
    # exist for the offered email.
    user = db.execute(
        select(User).where(User.email == body["owner"]["email"].lower())
    ).scalar_one_or_none()
    assert user is None


@pytest.mark.asyncio
async def test_onboard_rejects_bad_slug_format(client, db):
    """Slug regex enforced (lowercase, digits, hyphens only)."""
    body = _payload(slug="Bad Slug!")
    res = await client.post("/api/v1/onboard/restaurant", json=body)
    assert res.status_code == 422  # pydantic validation
