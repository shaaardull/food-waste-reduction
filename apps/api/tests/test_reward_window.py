"""§12 reward decisions: reward_type choice + 15-day full / 30-day half / expired window.

These tests walk the full happy path (register → order → captures → approve)
and then exercise the new endpoints + half-value logic. Time-travel is done
by reaching into the DB and rewriting issued_at / half_value_at / expires_at
on the reward row.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.reward import Reward
from tests.conftest import (
    login,
    make_restaurant,
    make_staff,
    make_table_code,
    png_bytes,
    register_diner,
)


async def _issue_reward(client, db, fake_s3, fake_scoring, label: str):
    restaurant, items, rule = make_restaurant(db, name=f"Win {label}")
    staff = make_staff(db, restaurant.id)
    _, diner_token = await register_diner(client, label=f"win{label}")

    sess = (await client.post(
        "/api/v1/sessions",
        json={
            "table_code": make_table_code(label),
            "restaurant_id": str(restaurant.id),
        },
        headers={"Authorization": f"Bearer {diner_token}"},
    )).json()
    session_id = sess["session_id"]

    await client.post(
        f"/api/v1/sessions/{session_id}/items",
        json={"items": [{"menu_item_id": str(items[0].id), "quantity": 1, "portion_size": "small"}]},
        headers={"Authorization": f"Bearer {diner_token}"},
    )

    files = {"image": ("before.png", png_bytes(color=(180, 90, 60)), "image/png")}
    b = await client.post(
        f"/api/v1/sessions/{session_id}/captures/before",
        files=files,
        data={"nonce": sess["before_capture_nonce"], "client_lat": "19.06", "client_lng": "72.83"},
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    after_nonce = b.json()["after_capture_nonce"]
    files = {"image": ("after.png", png_bytes(color=(40, 200, 100)), "image/png")}
    await client.post(
        f"/api/v1/sessions/{session_id}/captures/after",
        files=files,
        data={"nonce": after_nonce, "client_lat": "19.06", "client_lng": "72.83"},
        headers={"Authorization": f"Bearer {diner_token}"},
    )

    staff_token = await login(client, staff.email)
    val = (await client.post(
        f"/api/v1/sessions/{session_id}/validate",
        json={"decision": "approved"},
        headers={"Authorization": f"Bearer {staff_token}"},
    )).json()
    code = val["reward"]["redemption_code"]
    return {
        "restaurant": restaurant,
        "items": items,
        "rule": rule,
        "staff_token": staff_token,
        "diner_token": diner_token,
        "code": code,
        "reward_id": val["reward"]["id"],
    }


@pytest.mark.asyncio
async def test_reward_issued_with_window_and_default_type(client, db, fake_s3, fake_scoring):
    ctx = await _issue_reward(client, db, fake_s3, fake_scoring, label="iss")
    settings = get_settings()

    res = await client.get(
        f"/api/v1/rewards/{ctx['code']}",
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()["reward"]
    assert body["reward_type"] == "menu_item"
    # value_minor equals the rule's reward menu item price.
    assert body["value_minor"] == ctx["items"][1].price_minor  # items[1] is the dessert

    issued = datetime.fromisoformat(body["issued_at"])
    half = datetime.fromisoformat(body["half_value_at"])
    expires = datetime.fromisoformat(body["expires_at"])
    assert (half - issued).days == settings.REWARD_FULL_VALUE_DAYS
    assert (expires - issued).days == settings.REWARD_EXPIRY_DAYS
    assert body["current_value_minor"] == body["value_minor"]


@pytest.mark.asyncio
async def test_choose_type_to_bill_discount(client, db, fake_s3, fake_scoring):
    ctx = await _issue_reward(client, db, fake_s3, fake_scoring, label="ct")
    res = await client.post(
        f"/api/v1/rewards/{ctx['code']}/choose-type",
        json={"reward_type": "bill_discount"},
        headers={"Authorization": f"Bearer {ctx['diner_token']}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["reward_type"] == "bill_discount"
    # Seed sets bill_discount_minor = dessert price.
    assert body["value_minor"] == ctx["items"][1].price_minor


@pytest.mark.asyncio
async def test_choose_type_rejects_unknown(client, db, fake_s3, fake_scoring):
    ctx = await _issue_reward(client, db, fake_s3, fake_scoring, label="bad")
    res = await client.post(
        f"/api/v1/rewards/{ctx['code']}/choose-type",
        json={"reward_type": "rocket-launcher"},
        headers={"Authorization": f"Bearer {ctx['diner_token']}"},
    )
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_choose_type_only_diner_can_call(client, db, fake_s3, fake_scoring):
    ctx = await _issue_reward(client, db, fake_s3, fake_scoring, label="own")
    res = await client.post(
        f"/api/v1/rewards/{ctx['code']}/choose-type",
        json={"reward_type": "bill_discount"},
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_redeem_within_full_window_pays_full(client, db, fake_s3, fake_scoring):
    ctx = await _issue_reward(client, db, fake_s3, fake_scoring, label="full")
    res = await client.post(
        f"/api/v1/rewards/{ctx['code']}/redeem",
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["redeemed_value_minor"] == body["value_minor"]


@pytest.mark.asyncio
async def test_redeem_after_half_window_pays_half(client, db, fake_s3, fake_scoring):
    ctx = await _issue_reward(client, db, fake_s3, fake_scoring, label="half")
    # Fast-forward: pretend it's day 20 (issued 20 days ago).
    engine = create_engine(get_settings().DATABASE_URL_SYNC, future=True)
    with Session(engine, future=True) as s:
        reward = s.execute(
            select(Reward).where(Reward.redemption_code == ctx["code"])
        ).scalar_one()
        twenty_days_ago = datetime.now(UTC) - timedelta(days=20)
        reward.issued_at = twenty_days_ago
        reward.half_value_at = twenty_days_ago + timedelta(days=15)  # → 5 days ago, in the past
        reward.expires_at = twenty_days_ago + timedelta(days=30)  # → still in the future
        s.commit()

    res = await client.post(
        f"/api/v1/rewards/{ctx['code']}/redeem",
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["redeemed_value_minor"] == body["value_minor"] // 2


@pytest.mark.asyncio
async def test_redeem_after_expiry_returns_410(client, db, fake_s3, fake_scoring):
    ctx = await _issue_reward(client, db, fake_s3, fake_scoring, label="exp")
    engine = create_engine(get_settings().DATABASE_URL_SYNC, future=True)
    with Session(engine, future=True) as s:
        reward = s.execute(
            select(Reward).where(Reward.redemption_code == ctx["code"])
        ).scalar_one()
        forty_days_ago = datetime.now(UTC) - timedelta(days=40)
        reward.issued_at = forty_days_ago
        reward.half_value_at = forty_days_ago + timedelta(days=15)
        reward.expires_at = forty_days_ago + timedelta(days=30)  # → 10 days in the past
        s.commit()

    res = await client.post(
        f"/api/v1/rewards/{ctx['code']}/redeem",
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    assert res.status_code == 410


@pytest.mark.asyncio
async def test_choose_type_after_redeem_returns_409(client, db, fake_s3, fake_scoring):
    ctx = await _issue_reward(client, db, fake_s3, fake_scoring, label="late")
    await client.post(
        f"/api/v1/rewards/{ctx['code']}/redeem",
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    res = await client.post(
        f"/api/v1/rewards/{ctx['code']}/choose-type",
        json={"reward_type": "bill_discount"},
        headers={"Authorization": f"Bearer {ctx['diner_token']}"},
    )
    assert res.status_code == 409
