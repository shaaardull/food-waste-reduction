"""Integration tests for the admin / owner write endpoints (§5.2 + §5.5).

Covers POST /restaurants, PATCH /restaurants/:id, POST .../menu-items,
POST .../reward-rules, POST .../staff. Verifies the role gates: admin can
create restaurants; only owner-at-this-restaurant (or any admin) can patch /
add menu items / reward rules / staff.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.restaurant import RestaurantStaff
from app.models.user import User
from app.security import hash_password
from tests.conftest import (
    login,
    make_email,
    make_restaurant,
    make_slug,
    make_staff,
    register_diner,
)


def _make_admin(db: Session, password: str = "plate-clean-demo") -> User:
    user = User(
        email=make_email("admin"),
        display_name="Test Admin",
        role="admin",
        password_hash=hash_password(password),
    )
    db.add(user)
    db.commit()
    return user


def _make_owner(db: Session, restaurant_id, password: str = "plate-clean-demo") -> User:
    user = User(
        email=make_email("owner"),
        display_name="Test Owner",
        role="staff",
        password_hash=hash_password(password),
    )
    db.add(user)
    db.flush()
    db.add(RestaurantStaff(user_id=user.id, restaurant_id=restaurant_id, role="owner"))
    db.commit()
    return user


@pytest.mark.asyncio
async def test_create_restaurant_admin_only(client, db):
    _, diner_token = await register_diner(client, label="ncadmin")
    res = await client.post(
        "/api/v1/restaurants",
        json={
            "name": "New Place",
            "slug": make_slug("new-place"),
            "address": "1 Demo St",
            "latitude": 19.0,
            "longitude": 72.8,
        },
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_create_restaurant_happy_path(client, db):
    admin = _make_admin(db)
    token = await login(client, admin.email)
    slug = make_slug("new")
    res = await client.post(
        "/api/v1/restaurants",
        json={
            "name": "Brand New",
            "slug": slug,
            "address": "1 Demo St",
            "latitude": 19.0,
            "longitude": 72.8,
            "theme_primary_color": "#7c3aed",
            "tagline": "Hello",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["slug"] == slug
    assert body["theme_primary_color"] == "#7c3aed"
    assert body["tagline"] == "Hello"


@pytest.mark.asyncio
async def test_create_restaurant_duplicate_slug(client, db):
    admin = _make_admin(db)
    token = await login(client, admin.email)
    slug = make_slug("dup")
    payload = {
        "name": "Dup",
        "slug": slug,
        "address": "1 Demo St",
        "latitude": 19.0,
        "longitude": 72.8,
    }
    first = await client.post(
        "/api/v1/restaurants",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert first.status_code == 201
    second = await client.post(
        "/api/v1/restaurants",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert second.status_code == 409


@pytest.mark.asyncio
async def test_patch_restaurant_owner_can_edit_own(client, db):
    restaurant, _, _ = make_restaurant(db, name="Patch Spot")
    owner = _make_owner(db, restaurant.id)
    token = await login(client, owner.email)
    res = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}",
        json={"tagline": "Updated tagline", "theme_primary_color": "#dc2626"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["tagline"] == "Updated tagline"
    assert body["theme_primary_color"] == "#dc2626"


@pytest.mark.asyncio
async def test_patch_restaurant_non_owner_staff_blocked(client, db):
    restaurant, _, _ = make_restaurant(db, name="Patch Block")
    staff = make_staff(db, restaurant.id)  # manager role, not owner
    token = await login(client, staff.email)
    res = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}",
        json={"tagline": "nope"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_add_menu_items_owner(client, db):
    restaurant, _, _ = make_restaurant(db, name="Menu Add")
    owner = _make_owner(db, restaurant.id)
    token = await login(client, owner.email)
    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/menu-items",
        json={
            "items": [
                {"name": "New Dish A", "price_minor": 25000, "category": "main"},
                {"name": "New Dish B", "price_minor": 8000, "category": "dessert", "is_reward_eligible": True},
            ]
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 201, res.text
    items = res.json()
    assert len(items) == 2
    assert any(i["name"] == "New Dish A" for i in items)


@pytest.mark.asyncio
async def test_add_reward_rule_validates_menu_item(client, db):
    restaurant, items, _ = make_restaurant(db, name="Rule Add")
    other, other_items, _ = make_restaurant(db, name="Other")
    owner = _make_owner(db, restaurant.id)
    token = await login(client, owner.email)
    # Foreign menu item should be rejected.
    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/reward-rules",
        json={
            "name": "Free thing",
            "consumption_threshold": "0.75",
            "reward_menu_item_id": str(other_items[1].id),
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_add_reward_rule_happy(client, db):
    restaurant, items, _ = make_restaurant(db, name="Rule OK")
    owner = _make_owner(db, restaurant.id)
    token = await login(client, owner.email)
    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/reward-rules",
        json={
            "name": "Free dessert",
            "consumption_threshold": "0.75",
            "reward_menu_item_id": str(items[1].id),
            "allowed_reward_types": ["menu_item", "bill_discount"],
            "bill_discount_minor": items[1].price_minor,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 201, res.text


@pytest.mark.asyncio
async def test_invite_staff(client, db):
    restaurant, _, _ = make_restaurant(db, name="Invite")
    owner = _make_owner(db, restaurant.id)
    token = await login(client, owner.email)
    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/staff",
        json={
            "email": make_email("invited"),
            "display_name": "Invited Server",
            "role": "server",
            "password": "plate-clean-demo",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["role"] == "server"

    # The new user should be able to log in with the temporary password.
    new_token = await login(client, body["email"])
    assert new_token

    # And should appear in restaurant_staff for this restaurant.
    res2 = db.execute(
        select(RestaurantStaff).where(
            RestaurantStaff.user_id == body["user_id"],
            RestaurantStaff.restaurant_id == restaurant.id,
        )
    )
    assert res2.scalar_one_or_none() is not None
