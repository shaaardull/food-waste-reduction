"""Tests for the reward_value_minor override and the new
Rewards analytics endpoints (rewards-summary, rewards-list).

Covers:
  • Issuance uses reward_rules.reward_value_minor when set.
  • Issuance falls back to the linked menu item's price when the
    override is NULL.
  • PATCH /reward-rules/:id accepts and clears the override.
  • rewards-summary returns correct today/week/month counts + values.
  • rewards-list is paginated by issued_at DESC and filterable by
    status.
"""
from __future__ import annotations

import uuid as _uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.orm import Session

from app.models.meal_session import MealSession
from app.models.restaurant import RestaurantStaff
from app.models.reward import Reward, RewardRule
from app.models.user import User
from app.security import hash_password
from tests.conftest import (
    login,
    make_email,
    make_restaurant,
    make_staff,
    make_table_code,
    png_bytes,
    register_diner,
)


def _make_owner(db: Session, restaurant_id, *, label: str = "rvo_owner") -> User:
    """Owner-role staff; needed for PATCH /reward-rules which is
    owner-or-admin."""
    u = User(
        email=make_email(label),
        display_name=f"Owner {label}",
        role="staff",
        password_hash=hash_password("plate-clean-demo"),
    )
    db.add(u)
    db.flush()
    db.add(RestaurantStaff(user_id=u.id, restaurant_id=restaurant_id, role="owner"))
    db.commit()
    return u


async def _run_reward_flow(
    client,
    db,
    *,
    label: str,
    rule_value_minor: int | None,
) -> tuple[Reward, dict]:
    """End-to-end: seed restaurant + rule, run diner-through-staff flow,
    return the persisted Reward row plus the validate-endpoint body.

    `rule_value_minor` is written directly onto the rule row before the
    reward is minted so the override path exercises the value chosen.
    """
    restaurant, items, rule = make_restaurant(db, name=f"Override {label}")
    if rule_value_minor is not None:
        rule.reward_value_minor = rule_value_minor
        db.commit()

    staff = make_staff(db, restaurant.id)
    _, diner_token = await register_diner(client, label=f"rvo{label}")

    sess_res = await client.post(
        "/api/v1/sessions",
        json={
            "table_code": make_table_code(label),
            "restaurant_id": str(restaurant.id),
        },
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert sess_res.status_code == 201, sess_res.text
    sess = sess_res.json()
    session_id = sess["session_id"]

    await client.post(
        f"/api/v1/sessions/{session_id}/items",
        json={
            "items": [
                {"menu_item_id": str(items[0].id), "quantity": 1, "portion_size": "small"}
            ]
        },
        headers={"Authorization": f"Bearer {diner_token}"},
    )

    files = {"image": ("before.png", png_bytes(color=(180, 90, 60)), "image/png")}
    b_res = await client.post(
        f"/api/v1/sessions/{session_id}/captures/before",
        files=files,
        data={
            "nonce": sess["before_capture_nonce"],
            "client_lat": "19.06",
            "client_lng": "72.83",
        },
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    after_nonce = b_res.json()["after_capture_nonce"]
    files = {"image": ("after.png", png_bytes(color=(40, 200, 100)), "image/png")}
    await client.post(
        f"/api/v1/sessions/{session_id}/captures/after",
        files=files,
        data={"nonce": after_nonce, "client_lat": "19.06", "client_lng": "72.83"},
        headers={"Authorization": f"Bearer {diner_token}"},
    )

    staff_token = await login(client, staff.email)
    val_res = await client.post(
        f"/api/v1/sessions/{session_id}/validate",
        json={"decision": "approved"},
        headers={"Authorization": f"Bearer {staff_token}"},
    )
    assert val_res.status_code == 200, val_res.text
    body = val_res.json()
    reward_id = body["reward"]["id"]

    # Refresh the row from a fresh session to avoid stale reads.
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session as SyncSession

    from app.config import get_settings

    engine = create_engine(get_settings().DATABASE_URL_SYNC, future=True)
    with SyncSession(engine, future=True) as s:
        reward = s.get(Reward, _uuid.UUID(reward_id))
        assert reward is not None
        # Detach so the caller can inspect it after the session closes.
        s.expunge(reward)
    return reward, body


@pytest.mark.asyncio
async def test_reward_rules_value_override(client, db, fake_s3, fake_scoring):
    """Rule with reward_value_minor=15000 (₹150) → the minted reward's
    value_minor is 15000, not the linked menu item's price (10000)."""
    reward, body = await _run_reward_flow(
        client, db, label="ov", rule_value_minor=15000
    )
    assert reward.value_minor == 15000
    assert body["reward"]["value_minor"] == 15000


@pytest.mark.asyncio
async def test_reward_rules_value_null_falls_back(client, db, fake_s3, fake_scoring):
    """Rule with reward_value_minor=NULL → the minted reward's
    value_minor equals the linked menu item's price (10000)."""
    reward, body = await _run_reward_flow(
        client, db, label="fb", rule_value_minor=None
    )
    # `make_restaurant` sets the reward menu item (dessert) price to 10000.
    assert reward.value_minor == 10000
    assert body["reward"]["value_minor"] == 10000


@pytest.mark.asyncio
async def test_reward_rules_patch_sets_and_clears_override(client, db):
    """PATCH /reward-rules/:id — set override → returned, clear → null."""
    restaurant, _, rule = make_restaurant(db, name="Patch Rule")
    owner = _make_owner(db, restaurant.id, label="patch_owner")
    token = await login(client, owner.email)

    # Set the override.
    res = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}/reward-rules/{rule.id}",
        json={"reward_value_minor": 20000},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["reward_value_minor"] == 20000

    # Clear the override (explicit null).
    res = await client.patch(
        f"/api/v1/restaurants/{restaurant.id}/reward-rules/{rule.id}",
        json={"reward_value_minor": None},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["reward_value_minor"] is None

    # Verify DB matches.
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session as SyncSession

    from app.config import get_settings

    engine = create_engine(get_settings().DATABASE_URL_SYNC, future=True)
    with SyncSession(engine, future=True) as s:
        refreshed = s.get(RewardRule, rule.id)
        assert refreshed is not None
        assert refreshed.reward_value_minor is None


def _seed_reward_row(
    db: Session,
    *,
    restaurant_id,
    rule_id,
    issued_at: datetime,
    value_minor: int = 10000,
    redeemed_at: datetime | None = None,
    voided_at: datetime | None = None,
    label: str = "rs",
) -> Reward:
    """Bare-bones reward row with a placeholder MealSession — used by the
    analytics-endpoint tests where we care about the reward row, not
    the full session state chain."""
    session = MealSession(
        diner_user_id=None,
        restaurant_id=restaurant_id,
        table_code=make_table_code(label),
        status="rewarded",
        started_at=issued_at - timedelta(minutes=30),
        expires_at=issued_at + timedelta(hours=4),
    )
    db.add(session)
    db.flush()
    reward = Reward(
        meal_session_id=session.id,
        reward_rule_id=rule_id,
        # Unique per row so the rewards.redemption_code UNIQUE constraint
        # never collides across a 60-row seed.
        redemption_code=f"RVO-{_uuid.uuid4().hex[:12].upper()}",
        reward_type="menu_item",
        value_minor=value_minor,
        issued_at=issued_at,
        half_value_at=issued_at + timedelta(days=15),
        expires_at=issued_at + timedelta(days=30),
        redeemed_at=redeemed_at,
        voided_at=voided_at,
    )
    db.add(reward)
    db.commit()
    return reward


@pytest.mark.asyncio
async def test_rewards_summary_correct_windows(client, db):
    """Seed rewards at various issued_at timestamps. Assert
    today/week/month counts + value totals + 14-day sparkline."""
    restaurant, _, rule = make_restaurant(db, name="Sum Rest")
    staff = make_staff(db, restaurant.id)

    now = datetime.now(UTC)
    today_at = now.replace(hour=12, minute=0, second=0, microsecond=0)
    # One reward today (₹100).
    _seed_reward_row(
        db, restaurant_id=restaurant.id, rule_id=rule.id,
        issued_at=today_at, value_minor=10000, label="today",
    )
    # Two rewards in the last 7 days (not today) — ₹50 each.
    _seed_reward_row(
        db, restaurant_id=restaurant.id, rule_id=rule.id,
        issued_at=today_at - timedelta(days=3), value_minor=5000, label="d3",
    )
    _seed_reward_row(
        db, restaurant_id=restaurant.id, rule_id=rule.id,
        issued_at=today_at - timedelta(days=5), value_minor=5000, label="d5",
    )
    # One reward in the last 30 days but outside 7d — ₹200.
    _seed_reward_row(
        db, restaurant_id=restaurant.id, rule_id=rule.id,
        issued_at=today_at - timedelta(days=20), value_minor=20000, label="d20",
    )
    # One reward well outside 30 days — should not appear anywhere.
    _seed_reward_row(
        db, restaurant_id=restaurant.id, rule_id=rule.id,
        issued_at=today_at - timedelta(days=60), value_minor=99999, label="d60",
    )

    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/rewards-summary",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()

    # today: 1 reward, ₹100 total
    assert body["today"]["count"] == 1
    assert body["today"]["value_minor"] == 10000
    # week: today + d3 + d5 = 3 rewards, ₹200
    assert body["week"]["count"] == 3
    assert body["week"]["value_minor"] == 20000
    # month: today + d3 + d5 + d20 = 4 rewards, ₹400
    assert body["month"]["count"] == 4
    assert body["month"]["value_minor"] == 40000
    # sparkline: 14 buckets — today's bucket is at index 13.
    sparkline = body["today"]["sparkline"]
    assert isinstance(sparkline, list)
    assert len(sparkline) == 14
    assert sparkline[13] == 1  # one reward today
    # Bucket at (13 - 3) = 10 has one, (13 - 5) = 8 has one.
    assert sparkline[10] == 1
    assert sparkline[8] == 1
    assert sum(sparkline) == 3  # d20 and d60 fall outside the 14-day window


@pytest.mark.asyncio
async def test_rewards_list_pagination_and_filter(client, db):
    """Insert 60 rewards, page through with limit=50, verify next_cursor
    yields the remaining 10. Filter by status=voided returns only voided."""
    restaurant, _, rule = make_restaurant(db, name="List Rest")
    staff = make_staff(db, restaurant.id)

    now = datetime.now(UTC)
    voided_ids: list[str] = []
    for i in range(60):
        issued = now - timedelta(minutes=i)  # newest first at i=0
        voided_at = issued + timedelta(minutes=1) if i % 15 == 0 else None
        # Rewards 0, 15, 30, 45 are voided (four rows).
        r = _seed_reward_row(
            db,
            restaurant_id=restaurant.id,
            rule_id=rule.id,
            issued_at=issued,
            value_minor=1000 + i,
            voided_at=voided_at,
            label=f"list{i:02d}",
        )
        if voided_at is not None:
            voided_ids.append(str(r.id))

    token = await login(client, staff.email)

    # Page 1: default limit=50 → 50 rows, next_cursor present.
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/rewards-list?limit=50",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    page1 = res.json()
    assert len(page1["rows"]) == 50
    assert page1["next_cursor"] is not None

    # Rows are sorted by issued_at DESC — the first row is the newest.
    first_issued = datetime.fromisoformat(page1["rows"][0]["issued_at"])
    last_issued = datetime.fromisoformat(page1["rows"][-1]["issued_at"])
    assert first_issued > last_issued

    # Page 2: use next_cursor → remaining 10 rows, next_cursor now null.
    # Pass `cursor` via params so the `+` in the timezone offset is
    # properly percent-encoded — a raw f-string would turn it into a
    # space and the datetime parser would 422.
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/rewards-list",
        params={"limit": 50, "cursor": page1["next_cursor"]},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    page2 = res.json()
    assert len(page2["rows"]) == 10
    assert page2["next_cursor"] is None

    # Status filter: only voided rows come back.
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/rewards-list?status=voided",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    voided_page = res.json()
    assert len(voided_page["rows"]) == 4
    assert all(row["status"] == "voided" for row in voided_page["rows"])
