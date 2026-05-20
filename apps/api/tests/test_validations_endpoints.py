"""Integration tests for the staff-validation endpoints (CLAUDE.md §5.6).

Phase 1 acceptance criterion: "100% of API endpoints have at least one
integration test, including all four staff validation outcomes (approved,
adjusted, rejected, escalated)."

Plus the ethics-rule-8 guard: staff cannot validate their own diner sessions.
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


async def _walk_to_pending_validation(client, db, fake_s3, fake_scoring, *, label_suffix):
    """Set up a session that has reached status='pending_staff_validation'."""
    restaurant, items, _ = make_restaurant(db, name=f"Val {label_suffix}")
    staff = make_staff(db, restaurant.id)
    diner_user, diner_token = await register_diner(client, label=f"vald-{label_suffix}")

    # Create session.
    res = await client.post(
        "/api/v1/sessions",
        json={
            "table_code": make_table_code(label_suffix),
            "restaurant_id": str(restaurant.id),
        },
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert res.status_code == 201, res.text
    session_id = res.json()["session_id"]
    before_nonce = res.json()["before_capture_nonce"]

    # Add items.
    await client.post(
        f"/api/v1/sessions/{session_id}/items",
        json={
            "items": [
                {"menu_item_id": str(items[0].id), "quantity": 1, "portion_size": "small"}
            ]
        },
        headers={"Authorization": f"Bearer {diner_token}"},
    )

    # Before capture.
    files = {"image": ("before.png", png_bytes(color=(180, 90, 60)), "image/png")}
    data = {"nonce": before_nonce, "client_lat": "19.06", "client_lng": "72.83"}
    b = await client.post(
        f"/api/v1/sessions/{session_id}/captures/before",
        files=files,
        data=data,
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert b.status_code == 201, b.text
    after_nonce = b.json()["after_capture_nonce"]

    # After capture — fake_scoring writes a ConsumptionScore inline and
    # moves the session to pending_staff_validation.
    files = {"image": ("after.png", png_bytes(color=(40, 200, 100)), "image/png")}
    data = {"nonce": after_nonce, "client_lat": "19.06", "client_lng": "72.83"}
    a = await client.post(
        f"/api/v1/sessions/{session_id}/captures/after",
        files=files,
        data=data,
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert a.status_code == 201, a.text

    staff_token = await login(client, staff.email)
    return {
        "restaurant": restaurant,
        "session_id": session_id,
        "diner_user_id": diner_user["id"],
        "diner_token": diner_token,
        "staff": staff,
        "staff_token": staff_token,
    }


@pytest.mark.asyncio
async def test_pending_queue_lists_session(client, db, fake_s3, fake_scoring):
    ctx = await _walk_to_pending_validation(client, db, fake_s3, fake_scoring, label_suffix="q")
    res = await client.get(
        f"/api/v1/restaurants/{ctx['restaurant'].id}/validations/pending",
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    assert res.status_code == 200
    queue = res.json()
    assert any(s["session_id"] == ctx["session_id"] for s in queue)


@pytest.mark.asyncio
async def test_validation_bundle_returns_signed_urls(client, db, fake_s3, fake_scoring):
    ctx = await _walk_to_pending_validation(client, db, fake_s3, fake_scoring, label_suffix="b")
    res = await client.get(
        f"/api/v1/sessions/{ctx['session_id']}/validation-bundle",
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["before_image_url"].startswith("https://fake-s3.test/")
    assert body["after_image_url"].startswith("https://fake-s3.test/")


@pytest.mark.asyncio
async def test_validation_approved_with_high_score_issues_reward(
    client, db, fake_s3, fake_scoring
):
    ctx = await _walk_to_pending_validation(client, db, fake_s3, fake_scoring, label_suffix="a")
    res = await client.post(
        f"/api/v1/sessions/{ctx['session_id']}/validate",
        json={"decision": "approved"},
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["session"]["status"] == "rewarded"
    assert body["validation"]["decision"] == "approved"
    assert body["reward"] is not None
    assert body["reward"]["redemption_code"].startswith("PLATE-")


@pytest.mark.asyncio
async def test_validation_adjusted_to_below_threshold_no_reward(
    client, db, fake_s3, fake_scoring
):
    ctx = await _walk_to_pending_validation(client, db, fake_s3, fake_scoring, label_suffix="adj")
    res = await client.post(
        f"/api/v1/sessions/{ctx['session_id']}/validate",
        json={
            "decision": "adjusted",
            "final_score": 0.60,
            "reason_code": "model_overestimated",
            "notes": "Half the curry was left.",
        },
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["session"]["status"] == "staff_approved"
    assert body["validation"]["decision"] == "adjusted"
    assert body["validation"]["final_score"] == 0.6
    assert body["reward"] is None


@pytest.mark.asyncio
async def test_validation_rejected_no_reward(client, db, fake_s3, fake_scoring):
    ctx = await _walk_to_pending_validation(client, db, fake_s3, fake_scoring, label_suffix="rej")
    res = await client.post(
        f"/api/v1/sessions/{ctx['session_id']}/validate",
        json={"decision": "rejected", "reason_code": "wrong_plate_photographed"},
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["session"]["status"] == "staff_rejected"
    assert body["validation"]["decision"] == "rejected"
    assert body["reward"] is None


@pytest.mark.asyncio
async def test_validation_escalate_keeps_session_pending(client, db, fake_s3, fake_scoring):
    ctx = await _walk_to_pending_validation(client, db, fake_s3, fake_scoring, label_suffix="esc")
    res = await client.post(
        f"/api/v1/sessions/{ctx['session_id']}/validate/escalate",
        json={"notes": "Unsure — calling the manager."},
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["session"]["status"] == "pending_staff_validation"


@pytest.mark.asyncio
async def test_validation_requires_reason_code_for_adjusted(
    client, db, fake_s3, fake_scoring
):
    ctx = await _walk_to_pending_validation(client, db, fake_s3, fake_scoring, label_suffix="rc")
    res = await client.post(
        f"/api/v1/sessions/{ctx['session_id']}/validate",
        json={"decision": "adjusted", "final_score": 0.6},
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    # Pydantic model-validator catches this before the route runs → 422.
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_validation_idempotent_same_decision(client, db, fake_s3, fake_scoring):
    ctx = await _walk_to_pending_validation(client, db, fake_s3, fake_scoring, label_suffix="idem")
    payload = {"decision": "approved"}
    first = await client.post(
        f"/api/v1/sessions/{ctx['session_id']}/validate",
        json=payload,
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    assert first.status_code == 200
    second = await client.post(
        f"/api/v1/sessions/{ctx['session_id']}/validate",
        json=payload,
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    # Same decision is a no-op (returns the existing validation).
    assert second.status_code == 200


@pytest.mark.asyncio
async def test_validation_conflicting_decision_returns_409(
    client, db, fake_s3, fake_scoring
):
    ctx = await _walk_to_pending_validation(client, db, fake_s3, fake_scoring, label_suffix="conf")
    first = await client.post(
        f"/api/v1/sessions/{ctx['session_id']}/validate",
        json={"decision": "approved"},
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    assert first.status_code == 200
    second = await client.post(
        f"/api/v1/sessions/{ctx['session_id']}/validate",
        json={"decision": "rejected", "reason_code": "wrong_plate_photographed"},
        headers={"Authorization": f"Bearer {ctx['staff_token']}"},
    )
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "VALIDATION_ALREADY_DECIDED"


@pytest.mark.asyncio
async def test_staff_cannot_validate_their_own_diner_session(
    client, db, fake_s3, fake_scoring
):
    """Ethics rule 8: staff_user_id != diner_user_id."""
    from sqlalchemy import select

    from app.models.user import User

    ctx = await _walk_to_pending_validation(
        client, db, fake_s3, fake_scoring, label_suffix="self"
    )
    # Promote the diner to staff at the same restaurant — now we can test the guard.
    diner = db.execute(
        select(User).where(User.id == ctx["diner_user_id"])
    ).scalar_one()
    diner.role = "staff"
    from app.models.restaurant import RestaurantStaff

    db.add(
        RestaurantStaff(
            user_id=diner.id, restaurant_id=ctx["restaurant"].id, role="server"
        )
    )
    db.commit()

    # The diner now logs in (but they don't have a password — we'd have to add
    # one). Easier: just re-login as that diner using the existing token,
    # because the JWT still works post-promotion.
    diner_token = ctx["diner_token"]
    res = await client.post(
        f"/api/v1/sessions/{ctx['session_id']}/validate",
        json={"decision": "approved"},
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert res.status_code == 403
