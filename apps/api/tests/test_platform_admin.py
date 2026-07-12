"""Tests for the platform-owner backdoor surface and the bug-report
lifecycle:

Access model:
  • `/admin/platform/*` returns 404 (not 403) for anyone whose JWT
    role isn't 'admin' — the URL is meant to be hidden, so a stray
    curl by a staff who guessed the path can't confirm existence.
  • `/bug-reports` is available to any signed-in staff or admin.
    A diner has no restaurant context so the auto-attach falls back
    to `restaurant_id = None`; we let that through (a diner is a
    valid platform user with valid bug feedback).

Coverage:
  • create / list-mine / admin-list / admin-patch happy paths
  • the backdoor 404 for non-admins
  • analytics summary shape survives an empty database
  • drill-down 404 for a bad restaurant ID
  • drill-down happy path with a seeded validation and a bill
"""
from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from tests.conftest import (
    login,
    make_email,
    make_restaurant,
    make_staff,
    make_table_code,
    register_diner,
)


def _make_admin(db, password: str = "plate-clean-demo"):
    from app.models.user import User as UserModel
    from app.security import hash_password

    u = UserModel(
        email=make_email("platform-admin"),
        display_name="Platform Admin",
        role="admin",
        password_hash=hash_password(password),
    )
    db.add(u)
    db.commit()
    return u


# ── Bug reports: create + read ─────────────────────────────────────


@pytest.mark.asyncio
async def test_staff_can_file_bug_report(client, db):
    restaurant, _, _ = make_restaurant(db, name="Bug Reporter")
    staff = make_staff(db, restaurant.id)
    token = await login(client, staff.email)
    res = await client.post(
        "/api/v1/bug-reports",
        json={
            "title": "Camera flash won't turn off between captures",
            "description": (
                "After the diner captures the before photo, the camera "
                "flash indicator stays on until they refresh."
            ),
            "severity": "medium",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["title"].startswith("Camera flash")
    assert body["severity"] == "medium"
    assert body["status"] == "open"
    # Auto-attached to the staff's restaurant.
    assert body["restaurant_id"] == str(restaurant.id)
    assert body["restaurant_name"] == "Bug Reporter"
    assert body["reported_by_user_id"] == str(staff.id)


@pytest.mark.asyncio
async def test_bug_report_wrong_restaurant_blocked(client, db):
    """Staff of restaurant A can't file against restaurant B."""
    home, _, _ = make_restaurant(db, name="Bug Home")
    foreign, _, _ = make_restaurant(db, name="Bug Foreign")
    staff = make_staff(db, home.id)
    token = await login(client, staff.email)
    res = await client.post(
        "/api/v1/bug-reports",
        json={
            "title": "Cross-tenant attempt",
            "description": "should not be allowed under any auth model",
            "severity": "low",
            "restaurant_id": str(foreign.id),
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_staff_can_see_their_own_bugs(client, db):
    restaurant, _, _ = make_restaurant(db, name="Bug Own")
    staff = make_staff(db, restaurant.id)
    token = await login(client, staff.email)
    await client.post(
        "/api/v1/bug-reports",
        json={
            "title": "Bug I filed",
            "description": "long enough description to pass validation",
            "severity": "low",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    mine = await client.get(
        "/api/v1/bug-reports/mine",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert mine.status_code == 200
    titles = [b["title"] for b in mine.json()]
    assert "Bug I filed" in titles


# ── Backdoor auth: non-admins get 404 ──────────────────────────────


@pytest.mark.asyncio
async def test_platform_analytics_returns_404_for_non_admin(client, db):
    """Backdoor hardening: staff who guesses the URL can't distinguish
    "no access" from "no such endpoint" — that's the point."""
    restaurant, _, _ = make_restaurant(db, name="Snoop")
    staff = make_staff(db, restaurant.id)
    token = await login(client, staff.email)
    for path in (
        "/api/v1/admin/platform/analytics",
        "/api/v1/admin/platform/bug-reports",
        f"/api/v1/admin/platform/restaurants/{restaurant.id}/analytics",
    ):
        res = await client.get(
            path, headers={"Authorization": f"Bearer {token}"}
        )
        assert res.status_code == 404, f"path {path} leaked its existence"


@pytest.mark.asyncio
async def test_platform_analytics_404_for_diner(client, db):
    _, token = await register_diner(client, label="platform-snoop")
    res = await client.get(
        "/api/v1/admin/platform/analytics",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 404


# ── Admin analytics ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_platform_analytics_summary_shape(client, db):
    admin = _make_admin(db)
    token = await login(client, admin.email)
    res = await client.get(
        "/api/v1/admin/platform/analytics?range=30d",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["range"] == "30d"
    summary = body["summary"]
    for key in (
        "restaurants_total",
        "restaurants_active",
        "diners_total",
        "diners_active",
        "sessions_total",
        "kg_food_saved",
        "kg_co2e_saved",
        "rewards_issued",
        "rewards_redeemed",
        "revenue_paise",
        "gst_paise",
        "disputes_filed",
        "bugs_open",
    ):
        assert key in summary, f"summary missing key {key}"
    # Leaderboard: list of dicts with the expected shape (may be
    # empty depending on other tests running against the same db).
    assert isinstance(body["restaurants"], list)


@pytest.mark.asyncio
async def test_restaurant_drilldown_404_for_missing(client, db):
    admin = _make_admin(db)
    token = await login(client, admin.email)
    import uuid as _uuid

    fake_id = _uuid.uuid4()
    res = await client.get(
        f"/api/v1/admin/platform/restaurants/{fake_id}/analytics",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_restaurant_drilldown_happy_path(client, db):
    """Seed a validation + bill + reward for one restaurant and
    verify the drill-down surfaces them."""
    from app.models.bill import Bill
    from app.models.meal_session import MealSession, MealSessionItem
    from app.models.reward import Reward
    from app.models.staff_validation import StaffValidation

    restaurant, items, rule = make_restaurant(db, name="Drilldown Spot")
    # Register the diner via the API so we get the same shape as prod.
    diner_user, _ = await register_diner(client, label="drilldown-diner-real")
    # Fetch the ORM row so we can attach children by ID.
    from app.models.user import User as UserModel

    diner_row = db.get(UserModel, __import__("uuid").UUID(diner_user["id"]))
    session = MealSession(
        diner_user_id=diner_row.id,
        restaurant_id=restaurant.id,
        # Use the RUN_TAG-scoped table code so the conftest teardown
        # picks this session (and its Bill/Reward/Validation children)
        # up. Anything off-pattern leaks and blocks the FK cleanup.
        table_code=make_table_code("drill"),
        status="rewarded",
        started_at=datetime.now(UTC),
        expires_at=datetime.now(UTC),
    )
    db.add(session)
    db.flush()
    db.add(
        MealSessionItem(
            meal_session_id=session.id,
            menu_item_id=items[0].id,
            quantity=1,
            portion_size="regular",
        )
    )
    db.add(
        StaffValidation(
            meal_session_id=session.id,
            staff_user_id=diner_row.id,  # OK for aggregate — not enforced here
            restaurant_id=restaurant.id,
            decision="approved",
            model_score=Decimal("0.85"),
            final_score=Decimal("0.85"),
            reason_code=None,
            decision_latency_ms=1200,
            decided_at=datetime.now(UTC),
        )
    )
    db.add(
        Reward(
            meal_session_id=session.id,
            reward_rule_id=rule.id,
            # Unique-per-run code so a rerun after a partial cleanup
            # doesn't trip the rewards_redemption_code_key constraint.
            redemption_code=f"PLATE-{__import__('uuid').uuid4().hex[:8].upper()}",
            reward_type="menu_item",
            value_minor=10000,
            issued_at=datetime.now(UTC),
            half_value_at=datetime.now(UTC),
            expires_at=datetime.now(UTC),
        )
    )
    db.add(
        Bill(
            meal_session_id=session.id,
            restaurant_id=restaurant.id,
            # Unique per run so we don't collide with a prior seed
            # in the same partial-cleanup scenario.
            bill_number=f"TEST/DRILL/{__import__('uuid').uuid4().hex[:6].upper()}",
            subtotal_minor=30000,
            discount_minor=0,
            reward_redemption_code=None,
            taxable_amount_minor=30000,
            cgst_rate=Decimal("0.025"),
            sgst_rate=Decimal("0.025"),
            cgst_amount_minor=750,
            sgst_amount_minor=750,
            total_minor=31500,
            currency="INR",
            line_items_json=[],
            delivery_email=None,
            delivery_phone=None,
            delivery_status="pending",
            issued_at=datetime.now(UTC),
        )
    )
    db.commit()

    admin = _make_admin(db)
    token = await login(client, admin.email)
    res = await client.get(
        f"/api/v1/admin/platform/restaurants/{restaurant.id}/analytics?range=30d",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["restaurant"]["name"] == "Drilldown Spot"
    assert body["activity"]["sessions_total"] >= 1
    assert body["activity"]["validations_approved"] >= 1
    assert body["revenue"]["revenue_paise"] >= 31500
    assert body["revenue"]["gst_paise"] >= 1500
    assert body["rewards"]["issued"] >= 1


# ── Admin bug triage ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_can_list_and_patch_bug_report(client, db):
    # Staff files.
    restaurant, _, _ = make_restaurant(db, name="Bug Triage")
    staff = make_staff(db, restaurant.id)
    staff_token = await login(client, staff.email)
    filed = await client.post(
        "/api/v1/bug-reports",
        json={
            "title": "Reward chip briefly rendered as NaN",
            "description": "Repro: reward with half_value_at in the past.",
            "severity": "high",
        },
        headers={"Authorization": f"Bearer {staff_token}"},
    )
    bug_id = filed.json()["id"]

    # Admin lists + sees it.
    admin = _make_admin(db)
    admin_token = await login(client, admin.email)
    listing = await client.get(
        "/api/v1/admin/platform/bug-reports?status=open",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert listing.status_code == 200
    ids = [b["id"] for b in listing.json()]
    assert bug_id in ids

    # Admin triages the report.
    patched = await client.patch(
        f"/api/v1/admin/platform/bug-reports/{bug_id}",
        json={
            "status": "in_progress",
            "admin_notes": "reproduced locally; fix in reward panel",
        },
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert patched.status_code == 200, patched.text
    body = patched.json()
    assert body["status"] == "in_progress"
    assert body["admin_notes"].startswith("reproduced")


@pytest.mark.asyncio
async def test_admin_patch_immutable_fields_ignored(client, db):
    """Payload only supports status + admin_notes. A caller who tries
    to send title/description/severity gets those silently ignored;
    the row's originals stand for the audit trail."""
    restaurant, _, _ = make_restaurant(db, name="Bug Immut")
    staff = make_staff(db, restaurant.id)
    staff_token = await login(client, staff.email)
    filed = await client.post(
        "/api/v1/bug-reports",
        json={
            "title": "Original title",
            "description": "an original description here",
            "severity": "low",
        },
        headers={"Authorization": f"Bearer {staff_token}"},
    )
    bug_id = filed.json()["id"]

    admin = _make_admin(db)
    admin_token = await login(client, admin.email)
    patched = await client.patch(
        f"/api/v1/admin/platform/bug-reports/{bug_id}",
        json={
            "status": "wont_fix",
            "title": "Hijacked title",  # unknown field → Pydantic drops
            "severity": "critical",
        },
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["title"] == "Original title"
    assert body["severity"] == "low"
    assert body["status"] == "wont_fix"
