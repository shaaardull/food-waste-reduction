"""Tests for the Gap-D billing config on restaurants — GSTIN, gst_rate,
hsn_code, bill_prefix. Bill generation itself is covered in the next
commit; this file only checks that the config flows through the
create + patch endpoints and applies sensible defaults.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from tests.conftest import login, make_email, make_restaurant, make_staff


@pytest.mark.asyncio
async def test_restaurant_defaults_indian_dine_in_rates(client, db):
    """A restaurant created without any GST payload should get the
    5% default (dine-in, non-hotel, India) — CGST 2.5% + SGST 2.5%
    is calculated at bill time from this single rate."""
    restaurant, _, _ = make_restaurant(db, name="Default GST")
    assert restaurant.gst_rate == Decimal("0.050")
    assert restaurant.hsn_code == "9963"
    assert restaurant.gstin is None
    assert restaurant.bill_prefix is None


@pytest.mark.asyncio
async def test_patch_restaurant_sets_gstin(client, db):
    restaurant, _, _ = make_restaurant(db, name="GSTIN Patch")
    # A "staff" role user with the owner join.
    from app.models.restaurant import RestaurantStaff
    from app.models.user import User
    from app.security import hash_password

    owner = User(
        email=make_email("gst-owner"),
        display_name="GST Owner",
        role="staff",
        password_hash=hash_password("plate-clean-demo"),
    )
    db.add(owner)
    db.flush()
    db.add(
        RestaurantStaff(user_id=owner.id, restaurant_id=restaurant.id, role="owner")
    )
    db.commit()
    token = await login(client, owner.email)
    res = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}",
        json={
            "gstin": "27ABCDE1234F1Z5",
            "gst_rate": "0.180",
            "bill_prefix": "SPT/2026/",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["gstin"] == "27ABCDE1234F1Z5"
    # gst_rate serialises as string via Pydantic's Decimal handling; check
    # numeric equivalence.
    assert Decimal(str(body["gst_rate"])) == Decimal("0.180")
    assert body["bill_prefix"] == "SPT/2026/"


@pytest.mark.asyncio
async def test_patch_rejects_invalid_gstin(client, db):
    """Bogus GSTIN format must 422 — restaurant compliance leans on
    this field printing on the bill; a garbage string there gets the
    restaurant a real fine."""
    restaurant, _, _ = make_restaurant(db, name="Bad GSTIN")
    from app.models.restaurant import RestaurantStaff
    from app.models.user import User
    from app.security import hash_password

    owner = User(
        email=make_email("bad-gst-owner"),
        display_name="Owner",
        role="staff",
        password_hash=hash_password("plate-clean-demo"),
    )
    db.add(owner)
    db.flush()
    db.add(
        RestaurantStaff(user_id=owner.id, restaurant_id=restaurant.id, role="owner")
    )
    db.commit()
    token = await login(client, owner.email)
    res = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}",
        json={"gstin": "not-a-real-gstin"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_patch_rejects_out_of_range_gst_rate(client, db):
    """Cap at 0.28 (India's max slab). 0.50 = obviously wrong; must 422."""
    restaurant, _, _ = make_restaurant(db, name="Bad Rate")
    from app.models.restaurant import RestaurantStaff
    from app.models.user import User
    from app.security import hash_password

    owner = User(
        email=make_email("bad-rate-owner"),
        display_name="Owner",
        role="staff",
        password_hash=hash_password("plate-clean-demo"),
    )
    db.add(owner)
    db.flush()
    db.add(
        RestaurantStaff(user_id=owner.id, restaurant_id=restaurant.id, role="owner")
    )
    db.commit()
    token = await login(client, owner.email)
    res = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}",
        json={"gst_rate": "0.500"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_patch_non_owner_staff_still_blocked_on_gst(client, db):
    """Servers can edit menu (Gap-B/C policy), but restaurant CONFIG
    like GSTIN is owner-only — mirrors the existing restaurant PATCH
    gate."""
    restaurant, _, _ = make_restaurant(db, name="Gate GST")
    # make_staff creates a manager, not owner.
    staff = make_staff(db, restaurant.id)
    token = await login(client, staff.email)
    res = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}",
        json={"gstin": "27ABCDE1234F1Z5"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_get_restaurant_returns_gst_fields(client, db):
    restaurant, _, _ = make_restaurant(db, name="Get GST Fields")
    res = await client.get(f"/api/v1/restaurants/{restaurant.slug}")
    assert res.status_code == 200
    body = res.json()
    for key in ("gstin", "gst_rate", "hsn_code", "bill_prefix"):
        assert key in body, f"Missing key {key} in restaurant response"
    # Defaults are exposed publicly (there's no PII in these fields).
    assert Decimal(str(body["gst_rate"])) == Decimal("0.050")
    assert body["hsn_code"] == "9963"
