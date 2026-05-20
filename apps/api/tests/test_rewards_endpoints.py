"""Integration tests for /api/v1/rewards (CLAUDE.md §5.4).

Walks an approved validation, then exercises lookup → redeem → void.
"""
from __future__ import annotations

import pytest

from tests.conftest import (
    login,
    make_restaurant,
    make_staff,
    make_table_code,
    png_bytes,
    register_diner,
)


async def _issue_reward(client, db, fake_s3, fake_scoring, label: str):
    restaurant, items, _ = make_restaurant(db, name=f"Rew {label}")
    staff = make_staff(db, restaurant.id)
    diner_user, diner_token = await register_diner(client, label=f"rew{label}")

    sess_res = await client.post(
        "/api/v1/sessions",
        json={
            "table_code": make_table_code(label),
            "restaurant_id": str(restaurant.id),
        },
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    session_id = sess_res.json()["session_id"]
    before_nonce = sess_res.json()["before_capture_nonce"]
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
    data = {"nonce": before_nonce, "client_lat": "19.06", "client_lng": "72.83"}
    b = await client.post(
        f"/api/v1/sessions/{session_id}/captures/before",
        files=files,
        data=data,
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    after_nonce = b.json()["after_capture_nonce"]
    files = {"image": ("after.png", png_bytes(color=(40, 200, 100)), "image/png")}
    data = {"nonce": after_nonce, "client_lat": "19.06", "client_lng": "72.83"}
    await client.post(
        f"/api/v1/sessions/{session_id}/captures/after",
        files=files,
        data=data,
        headers={"Authorization": f"Bearer {diner_token}"},
    )

    staff_token = await login(client, staff.email)
    val_res = await client.post(
        f"/api/v1/sessions/{session_id}/validate",
        json={"decision": "approved"},
        headers={"Authorization": f"Bearer {staff_token}"},
    )
    assert val_res.status_code == 200
    code = val_res.json()["reward"]["redemption_code"]
    return restaurant, staff, staff_token, diner_token, code


@pytest.mark.asyncio
async def test_diner_sees_their_reward_in_list(client, db, fake_s3, fake_scoring):
    _, _, _, diner_token, code = await _issue_reward(client, db, fake_s3, fake_scoring, "list")
    res = await client.get(
        "/api/v1/rewards", headers={"Authorization": f"Bearer {diner_token}"}
    )
    assert res.status_code == 200
    codes = [r["redemption_code"] for r in res.json()]
    assert code in codes


@pytest.mark.asyncio
async def test_staff_lookup_returns_reward_and_session(client, db, fake_s3, fake_scoring):
    _, _, staff_token, _, code = await _issue_reward(client, db, fake_s3, fake_scoring, "look")
    res = await client.get(
        f"/api/v1/rewards/{code}", headers={"Authorization": f"Bearer {staff_token}"}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["reward"]["redemption_code"] == code
    assert body["session"]["status"] == "rewarded"


@pytest.mark.asyncio
async def test_staff_redeem_marks_redeemed(client, db, fake_s3, fake_scoring):
    _, _, staff_token, _, code = await _issue_reward(client, db, fake_s3, fake_scoring, "redeem")
    res = await client.post(
        f"/api/v1/rewards/{code}/redeem",
        headers={"Authorization": f"Bearer {staff_token}"},
    )
    assert res.status_code == 200
    assert res.json()["redeemed_at"]

    # Second redeem returns 409.
    second = await client.post(
        f"/api/v1/rewards/{code}/redeem",
        headers={"Authorization": f"Bearer {staff_token}"},
    )
    assert second.status_code == 409


@pytest.mark.asyncio
async def test_staff_void_marks_voided(client, db, fake_s3, fake_scoring):
    _, _, staff_token, _, code = await _issue_reward(client, db, fake_s3, fake_scoring, "void")
    res = await client.post(
        f"/api/v1/rewards/{code}/void",
        json={"reason": "guest left without paying"},
        headers={"Authorization": f"Bearer {staff_token}"},
    )
    assert res.status_code == 200
    assert res.json()["voided_at"]
    assert res.json()["voided_reason"] == "guest left without paying"


@pytest.mark.asyncio
async def test_diner_cannot_redeem_their_own_reward(client, db, fake_s3, fake_scoring):
    _, _, _, diner_token, code = await _issue_reward(client, db, fake_s3, fake_scoring, "diner")
    res = await client.post(
        f"/api/v1/rewards/{code}/redeem",
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert res.status_code == 403
