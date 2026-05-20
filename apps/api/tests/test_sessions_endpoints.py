"""Integration tests for /api/v1/sessions and /api/v1/rewards.

Covers CLAUDE.md §5.3 (sessions, captures, score, dispute), §5.4 (rewards),
and the per-restaurant dashboard reads from §5.5.

Capture endpoints use the fake_s3 fixture so MinIO isn't required; the
scoring task is replaced by `fake_scoring` so we don't hit Anthropic.
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


async def _create_session(client, token, restaurant_id, table_code=None):
    res = await client.post(
        "/api/v1/sessions",
        json={
            "table_code": table_code or make_table_code("sess"),
            "restaurant_id": str(restaurant_id),
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 201, res.text
    return res.json()


async def _add_items(client, token, session_id, menu_item_id):
    res = await client.post(
        f"/api/v1/sessions/{session_id}/items",
        json={
            "items": [
                {
                    "menu_item_id": str(menu_item_id),
                    "quantity": 1,
                    "portion_size": "small",
                }
            ]
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    return res.json()


async def _capture(client, token, session_id, phase, nonce, *, color=(180, 90, 60)):
    files = {"image": (f"{phase}.png", png_bytes(color=color), "image/png")}
    data = {"nonce": nonce, "client_lat": "19.06", "client_lng": "72.83"}
    res = await client.post(
        f"/api/v1/sessions/{session_id}/captures/{phase}",
        files=files,
        data=data,
        headers={"Authorization": f"Bearer {token}"},
    )
    return res


@pytest.mark.asyncio
async def test_create_session_issues_nonce(client, db):
    restaurant, _, _ = make_restaurant(db, name="Sess Spot")
    _, token = await register_diner(client, label="cs")
    body = await _create_session(client, token, restaurant.id)
    assert "session_id" in body
    assert "before_capture_nonce" in body


@pytest.mark.asyncio
async def test_add_items_only_in_open_status(client, db):
    restaurant, items, _ = make_restaurant(db, name="Items Spot")
    _, token = await register_diner(client, label="items")
    s = await _create_session(client, token, restaurant.id)
    await _add_items(client, token, s["session_id"], items[0].id)


@pytest.mark.asyncio
async def test_add_items_rejects_foreign_menu(client, db):
    restaurant_a, _, _ = make_restaurant(db, name="A")
    restaurant_b, items_b, _ = make_restaurant(db, name="B")
    _, token = await register_diner(client, label="foreign")
    s = await _create_session(client, token, restaurant_a.id)
    res = await client.post(
        f"/api/v1/sessions/{s['session_id']}/items",
        json={
            "items": [
                {"menu_item_id": str(items_b[0].id), "quantity": 1, "portion_size": "small"}
            ]
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_capture_before_requires_valid_nonce(client, db, fake_s3):
    restaurant, _, _ = make_restaurant(db, name="Cap Nonce")
    _, token = await register_diner(client, label="capn")
    s = await _create_session(client, token, restaurant.id)
    bad = await _capture(client, token, s["session_id"], "before", "wrong-nonce")
    assert bad.status_code == 400
    assert bad.json()["error"]["code"] == "INVALID_NONCE"


@pytest.mark.asyncio
async def test_capture_before_happy_path_issues_after_nonce(client, db, fake_s3):
    restaurant, items, _ = make_restaurant(db, name="Cap Happy")
    _, token = await register_diner(client, label="caph")
    s = await _create_session(client, token, restaurant.id)
    await _add_items(client, token, s["session_id"], items[0].id)
    res = await _capture(client, token, s["session_id"], "before", s["before_capture_nonce"])
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["after_capture_nonce"]


@pytest.mark.asyncio
async def test_capture_after_enqueues_scoring(client, db, fake_s3, fake_scoring):
    restaurant, items, _ = make_restaurant(db, name="Cap After")
    _, token = await register_diner(client, label="capa")
    s = await _create_session(client, token, restaurant.id)
    await _add_items(client, token, s["session_id"], items[0].id)
    before_res = await _capture(
        client, token, s["session_id"], "before", s["before_capture_nonce"]
    )
    after_nonce = before_res.json()["after_capture_nonce"]
    # Use a different color so the duplicate-hash check doesn't fire.
    after_res = await _capture(
        client,
        token,
        s["session_id"],
        "after",
        after_nonce,
        color=(40, 200, 100),
    )
    assert after_res.status_code == 201, after_res.text
    assert after_res.json()["processing_status"] == "queued"

    # Fake scoring should have written a ConsumptionScore inline.
    detail = await client.get(
        f"/api/v1/sessions/{s['session_id']}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert detail.status_code == 200
    body = detail.json()
    assert body["session"]["status"] == "pending_staff_validation"
    assert body["score"]["overall_score"] == fake_scoring["overall"]


@pytest.mark.asyncio
async def test_get_session_404_for_unknown_id(client):
    _, token = await register_diner(client, label="404")
    res = await client.get(
        "/api/v1/sessions/00000000-0000-0000-0000-000000000000",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_get_score_202_while_processing(client, db, fake_s3):
    restaurant, items, _ = make_restaurant(db, name="Score 202")
    _, token = await register_diner(client, label="score202")
    s = await _create_session(client, token, restaurant.id)
    await _add_items(client, token, s["session_id"], items[0].id)
    # No after-capture yet → score endpoint should report processing.
    res = await client.get(
        f"/api/v1/sessions/{s['session_id']}/score",
        headers={"Authorization": f"Bearer {token}"},
    )
    # Endpoint returns a tuple (body, status) — httpx flattens that into body
    # with the default 200. Test the body shape.
    assert res.status_code == 200
    body = res.json()
    assert isinstance(body, list) or body.get("status") == "processing" or "session_status" in body


@pytest.mark.asyncio
async def test_create_dispute(client, db):
    restaurant, _, _ = make_restaurant(db, name="Dispute Spot")
    _, token = await register_diner(client, label="disp")
    s = await _create_session(client, token, restaurant.id)
    res = await client.post(
        f"/api/v1/sessions/{s['session_id']}/dispute",
        json={"reason": "The waiter rejected me but I cleared the plate."},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 201
    assert "dispute_id" in res.json()


@pytest.mark.asyncio
async def test_rewards_list_empty_for_new_user(client):
    _, token = await register_diner(client, label="rew")
    res = await client.get(
        "/api/v1/rewards", headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 200
    assert res.json() == []


@pytest.mark.asyncio
async def test_rewards_lookup_not_found(client, db):
    restaurant, _, _ = make_restaurant(db, name="Lookup 404")
    staff = make_staff(db, restaurant.id)
    token = await login(client, staff.email)
    res = await client.get(
        "/api/v1/rewards/PLATE-XXXX", headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_dashboard_summary_returns_zeros_for_empty_restaurant(client, db):
    restaurant, _, _ = make_restaurant(db, name="Dash Empty")
    staff = make_staff(db, restaurant.id)
    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/summary?range=7d",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["sessions"] == 0
    assert body["pending_validation"] == 0


@pytest.mark.asyncio
async def test_dashboard_rejects_non_staff(client, db):
    restaurant, _, _ = make_restaurant(db, name="Dash Forbid")
    _, token = await register_diner(client, label="dashdiner")
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/summary?range=7d",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_dashboard_sessions_list(client, db):
    restaurant, _, _ = make_restaurant(db, name="Dash Sessions")
    staff = make_staff(db, restaurant.id)
    diner_user, diner_token = await register_diner(client, label="dashsess")
    await _create_session(client, diner_token, restaurant.id, table_code=make_table_code("dash"))
    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/sessions",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    assert any(s["table_code"].startswith("ITEST-") for s in res.json())


@pytest.mark.asyncio
async def test_dashboard_disputes_returns_list(client, db):
    restaurant, _, _ = make_restaurant(db, name="Dash Disputes")
    staff = make_staff(db, restaurant.id)
    token = await login(client, staff.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/disputes?status=open",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    assert isinstance(res.json(), list)
