"""Tests for the staff-side menu editor endpoints:

  PATCH   /restaurants/:id/menu-items/:item_id   partial update
  DELETE  /restaurants/:id/menu-items/:item_id   soft delete

Role gates: sprint decision was that any restaurant staff member —
owner, manager, or server — can edit the menu. A diner or a staff
member of a different restaurant is blocked.
"""
from __future__ import annotations

import pytest
from sqlalchemy.orm import Session

from app.models.menu_item import MenuItem
from app.models.restaurant import RestaurantStaff
from app.models.user import User
from app.security import hash_password
from tests.conftest import (
    login,
    make_email,
    make_restaurant,
    make_staff,
    register_diner,
)


def _make_server(db: Session, restaurant_id, password: str = "plate-clean-demo") -> User:
    """The `make_staff` fixture creates a `manager`; this variant creates
    a `server`. Both are 'staff' role users; the distinction is on the
    `restaurant_staff` join row."""
    user = User(
        email=make_email("server"),
        display_name="Test Server",
        role="staff",
        password_hash=hash_password(password),
    )
    db.add(user)
    db.flush()
    db.add(
        RestaurantStaff(user_id=user.id, restaurant_id=restaurant_id, role="server")
    )
    db.commit()
    return user


# ── PATCH ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_patch_menu_item_manager_can_edit(client, db):
    restaurant, items, _ = make_restaurant(db, name="Patch Manager")
    manager = make_staff(db, restaurant.id)  # manager role
    token = await login(client, manager.email)
    item = items[0]
    res = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/{item.id}",
        json={"price_minor": 42000},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["price_minor"] == 42000
    # Untouched fields must still be present with their original values.
    assert body["name"] == item.name


@pytest.mark.asyncio
async def test_patch_menu_item_server_can_edit(client, db):
    """Waiter-level access — the sprint decision was to allow this."""
    restaurant, items, _ = make_restaurant(db, name="Patch Server")
    server = _make_server(db, restaurant.id)
    token = await login(client, server.email)
    item = items[0]
    res = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/{item.id}",
        json={"description": "Now with extra ghee"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["description"] == "Now with extra ghee"


@pytest.mark.asyncio
async def test_patch_menu_item_partial_update_preserves_other_fields(client, db):
    """Only fields the client sent are applied. A missing `description`
    must not stomp the existing value with null."""
    restaurant, items, _ = make_restaurant(db, name="Patch Partial")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    item = items[0]
    original_name = item.name
    original_price = item.price_minor
    # Send only category; everything else should be unchanged.
    res = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/{item.id}",
        json={"category": "dessert"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["category"] == "dessert"
    assert body["name"] == original_name
    assert body["price_minor"] == original_price


@pytest.mark.asyncio
async def test_patch_menu_item_diner_blocked(client, db):
    restaurant, items, _ = make_restaurant(db, name="Patch Diner Block")
    _, diner_token = await register_diner(client)
    res = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/{items[0].id}",
        json={"price_minor": 1},
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_patch_menu_item_cross_restaurant_blocked(client, db):
    """Staff at restaurant A cannot edit items at restaurant B, even
    though they hold the staff role at their own place."""
    r_a, items_a, _ = make_restaurant(db, name="Cross A")
    r_b, _, _ = make_restaurant(db, name="Cross B")
    staff_b = make_staff(db, r_b.id)  # only on B's roster
    token = await login(client, staff_b.email)
    res = await client.patch(
        f"/api/v1/restaurants/{r_a.id}/menu-items/{items_a[0].id}",
        json={"price_minor": 1},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_patch_menu_item_wrong_restaurant_id_returns_404(client, db):
    """The item exists but belongs to another restaurant — treat as
    404, not 403, so we don't leak cross-tenant item existence."""
    r_a, items_a, _ = make_restaurant(db, name="Mismatch A")
    r_b, _, _ = make_restaurant(db, name="Mismatch B")
    staff_b = make_staff(db, r_b.id)
    token = await login(client, staff_b.email)
    res = await client.patch(
        # Staff of B is authorized on /restaurants/{r_b.id}/... but
        # references an item from A.
        f"/api/v1/restaurants/{r_b.id}/menu-items/{items_a[0].id}",
        json={"price_minor": 1},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 404


# ── DELETE (soft) ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_menu_item_soft_delete_flips_is_active(client, db):
    restaurant, items, _ = make_restaurant(db, name="Delete Soft")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    item = items[0]
    res = await client.delete(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/{item.id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["is_active"] is False
    # Row must survive — a fresh query should still find it.
    db.expire_all()
    reloaded = db.get(MenuItem, item.id)
    assert reloaded is not None
    assert reloaded.is_active is False


@pytest.mark.asyncio
async def test_delete_menu_item_hides_from_public_menu(client, db):
    """Diner-facing GET /restaurants/:id/menu filters is_active=true —
    once soft-deleted, the item must not appear."""
    restaurant, items, _ = make_restaurant(db, name="Delete Hides")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    victim = items[0]
    await client.delete(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/{victim.id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    res = await client.get(f"/api/v1/restaurants/{restaurant.id}/menu")
    assert res.status_code == 200
    names = [i["name"] for i in res.json()]
    assert victim.name not in names


@pytest.mark.asyncio
async def test_delete_menu_item_is_idempotent(client, db):
    """A second delete on the same already-inactive row is a no-op,
    not an error."""
    restaurant, items, _ = make_restaurant(db, name="Delete Idempotent")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    item = items[0]
    first = await client.delete(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/{item.id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert first.status_code == 200
    second = await client.delete(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/{item.id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert second.status_code == 200
    assert second.json()["is_active"] is False


@pytest.mark.asyncio
async def test_delete_can_be_undone_via_patch_is_active(client, db):
    """The 'Undo' chip in the dashboard toast just PATCHes is_active=true.
    Verify the roundtrip works."""
    restaurant, items, _ = make_restaurant(db, name="Undo Roundtrip")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    item = items[0]
    await client.delete(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/{item.id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    res = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/{item.id}",
        json={"is_active": True},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    assert res.json()["is_active"] is True


@pytest.mark.asyncio
async def test_delete_menu_item_diner_blocked(client, db):
    restaurant, items, _ = make_restaurant(db, name="Delete Diner Block")
    _, diner_token = await register_diner(client)
    res = await client.delete(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/{items[0].id}",
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert res.status_code == 403


# ── Bulk-add gate widening (regression) ──────────────────────────────


@pytest.mark.asyncio
async def test_staff_menu_items_list_defaults_active_only(client, db):
    """GET /menu-items without include_inactive must not leak
    soft-deleted rows into the default staff view."""
    restaurant, items, _ = make_restaurant(db, name="Staff Menu Active")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    # Soft-delete one item.
    victim = items[0]
    await client.delete(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/{victim.id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/menu-items",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    names = [i["name"] for i in res.json()]
    assert victim.name not in names


@pytest.mark.asyncio
async def test_staff_menu_items_list_include_inactive(client, db):
    restaurant, items, _ = make_restaurant(db, name="Staff Menu All")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    victim = items[0]
    await client.delete(
        f"/api/v1/restaurants/{restaurant.id}/menu-items/{victim.id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/menu-items?include_inactive=true",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    rows = res.json()
    assert any(r["name"] == victim.name and r["is_active"] is False for r in rows)


@pytest.mark.asyncio
async def test_staff_menu_items_list_diner_blocked(client, db):
    restaurant, _, _ = make_restaurant(db, name="Staff Menu Diner Block")
    _, diner_token = await register_diner(client)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/menu-items",
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_bulk_add_menu_items_manager_now_allowed(client, db):
    """Regression — before this sprint, POST /menu-items was owner-only.
    The gate is now `any restaurant staff`, so a manager posting a new
    special mid-service should get 201."""
    restaurant, _, _ = make_restaurant(db, name="Bulk Manager")
    manager = make_staff(db, restaurant.id)
    token = await login(client, manager.email)
    res = await client.post(
        f"/api/v1/restaurants/{restaurant.id}/menu-items",
        json={
            "items": [
                {
                    "name": "Chef's special",
                    "price_minor": 45000,
                    "category": "main",
                }
            ]
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 201, res.text
