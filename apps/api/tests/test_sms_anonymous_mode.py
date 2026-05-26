"""Tests for the anonymous-mode SMS reward dispatch.

CLAUDE.md §9 Phase 3 bullet. Verifies:
- The pure `is_phone_only_user` heuristic recognises the synthetic
  `phone+...@plate-clean.local` users created by /auth/otp/verify and
  doesn't false-positive on regular email accounts.
- `send_reward_sms` returns True under the console provider and doesn't
  blow up.
- End-to-end through staff validation: phone-only diners get an SMS
  with their reward code; regular email/password diners don't.
- A monkeypatched dispatcher that raises does NOT roll back the
  reward — SMS errors must never affect the grant.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models.meal_session import MealSession
from app.models.reward import Reward
from app.models.staff_validation import StaffValidation
from app.models.user import User
from app.services import sms as sms_module
from tests.conftest import (
    login,
    make_restaurant,
    make_staff,
    make_table_code,
    png_bytes,
    register_diner,
)


# ─── Bootstrap helper: same shape as tests/test_validations_endpoints.py ───


async def _walk_to_pending_validation(
    client, db, fake_s3, fake_scoring, *, label_suffix: str
):
    """Drive a session to status='pending_staff_validation' so we can
    drop a validate call on it."""
    restaurant, items, _ = make_restaurant(db, name=f"SMS {label_suffix}")
    staff = make_staff(db, restaurant.id)
    diner_user, diner_token = await register_diner(client, label=f"sms-{label_suffix}")

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
    assert b.status_code == 201, b.text
    after_nonce = b.json()["after_capture_nonce"]

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
        "restaurant_id": restaurant.id,
        "session_id": session_id,
        "diner_user_id": diner_user["id"],
        "staff_token": staff_token,
    }


# ─── Pure-function tests ────────────────────────────────────────────────


def test_is_phone_only_user_recognises_synthetic_email():
    assert sms_module.is_phone_only_user(
        "phone+919876543210@plate-clean.local", "+919876543210"
    ) is True


def test_is_phone_only_user_rejects_regular_email():
    assert sms_module.is_phone_only_user(
        "diner@example.com", "+919876543210"
    ) is False


def test_is_phone_only_user_rejects_no_phone():
    assert sms_module.is_phone_only_user(
        "phone+919876543210@plate-clean.local", None
    ) is False


def test_send_reward_sms_console_provider_returns_true():
    """Console mode returns True. We don't assert on the log payload
    because structlog formatting is implementation-detail; the contract
    is just 'doesn't raise + returns True'."""
    ok = sms_module.send_reward_sms(
        phone="+919876543210",
        code="PLATE-X7B2",
        restaurant_name="Spice Trail",
    )
    assert ok is True


def test_send_reward_sms_unknown_provider_returns_false(monkeypatch):
    """Misconfigured prod provider → returns False, doesn't raise."""
    from app.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "OTP_PROVIDER", "msg91")
    ok = sms_module.send_reward_sms(
        phone="+919876543210", code="PLATE-XXXX", restaurant_name="X"
    )
    assert ok is False


# ─── End-to-end: through staff validation ───────────────────────────────


@pytest.mark.asyncio
async def test_phone_only_diner_gets_sms_on_reward(
    client, db, fake_s3, fake_scoring, monkeypatch
):
    """Full path: phone-only diner walks the flow, staff approves
    above-threshold, send_reward_sms fires with the right code."""
    sent: list[dict[str, str]] = []

    def fake_send(*, phone, code, restaurant_name):
        sent.append({"phone": phone, "code": code, "restaurant_name": restaurant_name})
        return True

    monkeypatch.setattr(sms_module, "send_reward_sms", fake_send)
    # fake_scoring writes a high score (>= threshold) by default in conftest.

    setup = await _walk_to_pending_validation(
        client, db, fake_s3, fake_scoring, label_suffix="phone"
    )

    # Flip the diner to look phone-only.
    diner = db.execute(
        select(User).where(User.id == setup["diner_user_id"])
    ).scalar_one()
    diner.email = f"phone+anon{setup['diner_user_id'][:8]}@plate-clean.local"
    diner.phone = f"+91{setup['diner_user_id'].replace('-', '')[:10]}"
    db.commit()

    res = await client.post(
        f"/api/v1/sessions/{setup['session_id']}/validate",
        json={"decision": "approved"},
        headers={"Authorization": f"Bearer {setup['staff_token']}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body.get("reward") is not None, "Score below threshold — bump fake_scoring"
    reward_code = body["reward"]["redemption_code"]

    assert len(sent) == 1, f"Expected one SMS dispatch, got {len(sent)}"
    assert sent[0]["code"] == reward_code
    assert sent[0]["phone"] == diner.phone


@pytest.mark.asyncio
async def test_email_diner_does_not_get_sms(
    client, db, fake_s3, fake_scoring, monkeypatch
):
    """Regular email/password diner already sees the reward in the PWA —
    skip the SMS to avoid duplicate notifications."""
    sent: list[dict] = []
    monkeypatch.setattr(
        sms_module,
        "send_reward_sms",
        lambda **kw: (sent.append(kw) or True),
    )

    setup = await _walk_to_pending_validation(
        client, db, fake_s3, fake_scoring, label_suffix="email"
    )
    # Leave the diner as-is — register_diner makes them email/password,
    # no phone.

    res = await client.post(
        f"/api/v1/sessions/{setup['session_id']}/validate",
        json={"decision": "approved"},
        headers={"Authorization": f"Bearer {setup['staff_token']}"},
    )
    assert res.status_code == 200, res.text
    assert sent == [], "Should NOT dispatch SMS for non-phone-only diner"


@pytest.mark.asyncio
async def test_sms_failure_does_not_block_reward(
    client, db, fake_s3, fake_scoring, monkeypatch
):
    """Belt-and-braces — if the SMS dispatcher raises, the reward must
    still land. Staff already approved; we can't roll that back."""

    def boom(**_kw):
        raise RuntimeError("simulated provider outage")

    monkeypatch.setattr(sms_module, "send_reward_sms", boom)

    setup = await _walk_to_pending_validation(
        client, db, fake_s3, fake_scoring, label_suffix="boom"
    )

    diner = db.execute(
        select(User).where(User.id == setup["diner_user_id"])
    ).scalar_one()
    diner.email = f"phone+boom{setup['diner_user_id'][:8]}@plate-clean.local"
    diner.phone = f"+91{setup['diner_user_id'].replace('-', '')[:10]}"
    db.commit()

    res = await client.post(
        f"/api/v1/sessions/{setup['session_id']}/validate",
        json={"decision": "approved"},
        headers={"Authorization": f"Bearer {setup['staff_token']}"},
    )
    # The HTTP call succeeds, the reward is in the DB.
    assert res.status_code == 200, res.text
    body = res.json()
    assert body.get("reward") is not None

    # Double-check the row landed.
    row = db.execute(
        select(Reward).where(Reward.meal_session_id == setup["session_id"])
    ).scalar_one_or_none()
    assert row is not None
    # And the session is rewarded.
    session = db.execute(
        select(MealSession).where(MealSession.id == setup["session_id"])
    ).scalar_one()
    assert session.status == "rewarded"
    # And the validation row landed too — proves the SMS exception
    # didn't abort the wider transaction.
    assert (
        db.execute(
            select(StaffValidation).where(
                StaffValidation.meal_session_id == setup["session_id"]
            )
        ).scalar_one().decision
        == "approved"
    )
