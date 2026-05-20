"""Integration tests for the /api/v1/auth endpoints (CLAUDE.md §5.1)."""
from __future__ import annotations

import pytest

from tests.conftest import login, make_email, register_diner


@pytest.mark.asyncio
async def test_register_returns_user_and_token(client):
    user, token = await register_diner(client, label="reg1")
    assert user["email"].startswith("itest-")
    assert user["role"] == "diner"
    assert token


@pytest.mark.asyncio
async def test_register_rejects_minor(client):
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": make_email("minor"),
            "password": "plate-clean-demo",
            "display_name": "Minor",
            "is_adult": False,
        },
    )
    assert res.status_code == 400
    body = res.json()
    assert body["error"]["code"] == "MINOR_NOT_PERMITTED"


@pytest.mark.asyncio
async def test_register_duplicate_email_returns_409(client):
    email = make_email("dupe")
    payload = {
        "email": email,
        "password": "plate-clean-demo",
        "display_name": "Dupe",
        "is_adult": True,
    }
    first = await client.post("/api/v1/auth/register", json=payload)
    assert first.status_code == 201
    second = await client.post("/api/v1/auth/register", json=payload)
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "EMAIL_TAKEN"


@pytest.mark.asyncio
async def test_login_with_correct_password(client):
    user, _ = await register_diner(client, label="login")
    token = await login(client, user["email"])
    assert token


@pytest.mark.asyncio
async def test_login_with_wrong_password_returns_401(client):
    user, _ = await register_diner(client, label="wrongpw")
    res = await client.post(
        "/api/v1/auth/login", json={"email": user["email"], "password": "not-the-password"}
    )
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_me_returns_current_user(client):
    user, token = await register_diner(client, label="me")
    res = await client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["id"] == user["id"]
    assert body["email"] == user["email"]


@pytest.mark.asyncio
async def test_me_without_token_returns_401(client):
    res = await client.get("/api/v1/auth/me")
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_logout_succeeds_with_token(client):
    _, token = await register_diner(client, label="logout")
    res = await client.post(
        "/api/v1/auth/logout", headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 204


@pytest.mark.asyncio
async def test_delete_account_anonymizes(client):
    user, token = await register_diner(client, label="del")
    res = await client.delete(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 202
    # Subsequent /me with same token should now fail because the row was
    # soft-deleted (get_current_user filters deleted_at IS NULL).
    me_res = await client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert me_res.status_code == 401


@pytest.mark.asyncio
async def test_otp_request_returns_request_id(client):
    res = await client.post(
        "/api/v1/auth/otp/request", json={"phone": "+919000000111"}
    )
    assert res.status_code == 200
    body = res.json()
    assert "request_id" in body


@pytest.mark.asyncio
async def test_otp_verify_with_bad_code_returns_401(client):
    issued = await client.post(
        "/api/v1/auth/otp/request", json={"phone": "+919000000222"}
    )
    request_id = issued.json()["request_id"]
    res = await client.post(
        "/api/v1/auth/otp/verify", json={"request_id": request_id, "code": "999999"}
    )
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_otp_full_round_trip(client):
    """OTP request → look up the dev OTP in redis → verify → token issued."""
    import redis as _redis_sync

    from app.config import get_settings

    phone = "+919000000333"
    issued = await client.post("/api/v1/auth/otp/request", json={"phone": phone})
    request_id = issued.json()["request_id"]

    # In OTP_PROVIDER=console mode the code is stored directly in redis.
    r = _redis_sync.Redis.from_url(get_settings().REDIS_URL, decode_responses=True)
    stored = r.get(f"otp:{request_id}")
    assert stored is not None
    _phone, code = stored.split("|", 1)

    res = await client.post(
        "/api/v1/auth/otp/verify", json={"request_id": request_id, "code": code}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["user"]["phone"] == phone
    assert body["token"]
