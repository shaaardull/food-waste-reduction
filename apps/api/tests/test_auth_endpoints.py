"""Integration tests for the /api/v1/auth endpoints (CLAUDE.md §5.1)."""
from __future__ import annotations

import pytest

from tests.conftest import login, make_email, make_phone, register_diner


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
            "phone": make_phone(),
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
        "phone": make_phone(),
        "password": "plate-clean-demo",
        "display_name": "Dupe",
        "is_adult": True,
    }
    first = await client.post("/api/v1/auth/register", json=payload)
    assert first.status_code == 201
    # Second attempt shares email but has a fresh phone — should still
    # 409 on EMAIL_TAKEN specifically (not the generic ACCOUNT_TAKEN).
    second_payload = {**payload, "phone": make_phone()}
    second = await client.post("/api/v1/auth/register", json=second_payload)
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "EMAIL_TAKEN"


@pytest.mark.asyncio
async def test_register_duplicate_phone_returns_409(client):
    phone = make_phone()
    payload = {
        "email": make_email("phone-dupe-a"),
        "phone": phone,
        "password": "plate-clean-demo",
        "display_name": "Phone Dupe",
        "is_adult": True,
    }
    first = await client.post("/api/v1/auth/register", json=payload)
    assert first.status_code == 201
    # Fresh email, same phone — must trip PHONE_TAKEN specifically.
    second_payload = {**payload, "email": make_email("phone-dupe-b")}
    second = await client.post("/api/v1/auth/register", json=second_payload)
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "PHONE_TAKEN"


@pytest.mark.asyncio
async def test_register_persists_phone(client):
    """Dual-channel signup: /me should echo the phone we passed."""
    phone = make_phone()
    user, token = await register_diner(client, label="phone-echo", phone=phone)
    assert user["phone"] == phone
    me = await client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert me.json()["phone"] == phone


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


# ── Forgot / reset password ──────────────────────────────────────────


def _read_otp_from_redis(request_id: str) -> str:
    """Look up the reset OTP code in Redis. Reset codes are stored
    under the `reset_otp:` prefix (distinct from phone-verify OTPs
    which use `otp:`) since the sprint that keyed resets on user_id
    rather than phone."""
    import redis as _redis_sync

    from app.config import get_settings

    r = _redis_sync.Redis.from_url(get_settings().REDIS_URL, decode_responses=True)
    stored = r.get(f"reset_otp:{request_id}")
    assert stored is not None, (
        "reset OTP not found in Redis — /forgot-password did not issue one"
    )
    _user_id, code = stored.split("|", 1)
    return code


@pytest.mark.asyncio
async def test_forgot_password_by_email_issues_otp(client):
    phone = make_phone()
    user, _ = await register_diner(client, label="fp-email", phone=phone)
    res = await client.post(
        "/api/v1/auth/forgot-password", json={"identifier": user["email"]}
    )
    assert res.status_code == 200
    body = res.json()
    # Dual-channel: real diner emails should get a code via SMS AND
    # email. In practice the `delivery` string reflects what actually
    # landed — if the SMTP provider throttles or the test runner
    # hits Zoho's `Unusual sending activity` limiter, only `sms`
    # lands and the field says so. What we care about at the API
    # contract level is:
    #   • the request_id is real (not the enumeration-hardening
    #     noop-* placeholder), meaning at least ONE channel was
    #     attempted for a real user,
    #   • the OTP is in Redis so the reset can complete regardless
    #     of channel.
    assert not body["request_id"].startswith("noop-")
    assert "sms" in body["delivery"]  # SMS is always attempted (console log in dev)
    assert _read_otp_from_redis(body["request_id"])


def test_render_password_reset_email_shape():
    """Email renderer front-loads the code in the subject (deliverability
    win), shows it in mono block in the body, and includes the
    recipient for phishing-conscious skim."""
    from app.services.email import render_password_reset_email

    subject, plain, html = render_password_reset_email(
        email="diner@example.com", code="482915"
    )
    assert "482915" in subject
    assert "482915" in plain
    assert "482915" in html
    assert "diner@example.com" in plain
    assert "diner@example.com" in html
    # "Didn't request this?" copy is present so the diner has a
    # clear off-ramp without needing to contact support.
    assert "Didn't request" in plain
    assert "Didn't request" in html


@pytest.mark.asyncio
async def test_forgot_password_works_for_email_only_account(db, client):
    """Regression: pre-migration accounts have an email but no phone
    (they signed up before phone became required). Reset must still
    work for them — a user_id-keyed reset OTP, delivered inline by
    email, then verified against the user, then password rotated."""
    from app.models.user import User as UserModel
    from app.security import hash_password

    email = make_email("email-only")
    u = UserModel(
        email=email,
        # phone deliberately None — legacy row shape.
        display_name="Legacy Diner",
        role="diner",
        password_hash=hash_password("old-password-8chars"),
    )
    db.add(u)
    db.flush()
    db.commit()

    forgot = await client.post(
        "/api/v1/auth/forgot-password", json={"identifier": email}
    )
    assert forgot.status_code == 200, forgot.text
    body = forgot.json()
    # Real request_id, not a noop — reset was actually attempted.
    assert not body["request_id"].startswith("noop-")
    # In test env EMAIL_MODE=console → delivered_via ends up empty
    # (no SMS provider, no real SMTP). We still get the OTP into
    # Redis and can complete the reset.
    request_id = body["request_id"]
    code = _read_otp_from_redis(request_id)

    reset = await client.post(
        "/api/v1/auth/reset-password",
        json={
            "request_id": request_id,
            "code": code,
            "new_password": "brand-new-password",
        },
    )
    assert reset.status_code == 200, reset.text
    # Sign in with the new password — proves the reset landed on the
    # right user.
    signin = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "brand-new-password"},
    )
    assert signin.status_code == 200


@pytest.mark.asyncio
async def test_forgot_password_by_phone_issues_otp(client):
    phone = make_phone()
    await register_diner(client, label="fp-phone", phone=phone)
    res = await client.post(
        "/api/v1/auth/forgot-password", json={"identifier": phone}
    )
    assert res.status_code == 200
    assert not res.json()["request_id"].startswith("noop-")


@pytest.mark.asyncio
async def test_forgot_password_unknown_identifier_returns_noop(client):
    """Enumeration hardening: unknown email / phone still returns 200
    with a placeholder request_id that will never verify."""
    res = await client.post(
        "/api/v1/auth/forgot-password",
        json={"identifier": "nobody-here@example.com"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["request_id"].startswith("noop-")


@pytest.mark.asyncio
async def test_reset_password_end_to_end(client):
    """Register → forgot → read OTP → reset → log in with new password."""
    phone = make_phone()
    user, _ = await register_diner(
        client, label="reset-e2e", phone=phone, password="old-password-8chars"
    )
    forgot = await client.post(
        "/api/v1/auth/forgot-password", json={"identifier": user["email"]}
    )
    request_id = forgot.json()["request_id"]
    code = _read_otp_from_redis(request_id)

    reset = await client.post(
        "/api/v1/auth/reset-password",
        json={
            "request_id": request_id,
            "code": code,
            "new_password": "brand-new-password",
        },
    )
    assert reset.status_code == 200, reset.text
    body = reset.json()
    assert body["user"]["id"] == user["id"]
    assert body["token"]

    # Old password must NOT work.
    bad = await client.post(
        "/api/v1/auth/login",
        json={"email": user["email"], "password": "old-password-8chars"},
    )
    assert bad.status_code == 401

    # New password DOES work.
    good = await client.post(
        "/api/v1/auth/login",
        json={"email": user["email"], "password": "brand-new-password"},
    )
    assert good.status_code == 200


@pytest.mark.asyncio
async def test_reset_password_with_bad_code_returns_401(client):
    phone = make_phone()
    user, _ = await register_diner(client, label="reset-badcode", phone=phone)
    forgot = await client.post(
        "/api/v1/auth/forgot-password", json={"identifier": user["email"]}
    )
    request_id = forgot.json()["request_id"]
    res = await client.post(
        "/api/v1/auth/reset-password",
        json={
            "request_id": request_id,
            "code": "999999",
            "new_password": "brand-new-password",
        },
    )
    assert res.status_code == 401


# ── Change password (signed-in rotation) ────────────────────────────


@pytest.mark.asyncio
async def test_change_password_end_to_end(client):
    user, token = await register_diner(
        client, label="cp-happy", password="old-password-8chars"
    )
    res = await client.post(
        "/api/v1/auth/change-password",
        json={
            "current_password": "old-password-8chars",
            "new_password": "brand-new-password",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    # Old password no longer valid.
    bad = await client.post(
        "/api/v1/auth/login",
        json={"email": user["email"], "password": "old-password-8chars"},
    )
    assert bad.status_code == 401
    # New password works.
    good = await client.post(
        "/api/v1/auth/login",
        json={"email": user["email"], "password": "brand-new-password"},
    )
    assert good.status_code == 200


@pytest.mark.asyncio
async def test_change_password_wrong_current_returns_401(client):
    _, token = await register_diner(client, label="cp-wrong", password="old-password-8chars")
    res = await client.post(
        "/api/v1/auth/change-password",
        json={
            "current_password": "not-the-actual-password",
            "new_password": "brand-new-password",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_change_password_same_as_current_returns_400(client):
    _, token = await register_diner(
        client, label="cp-same", password="same-password-8char"
    )
    res = await client.post(
        "/api/v1/auth/change-password",
        json={
            "current_password": "same-password-8char",
            "new_password": "same-password-8char",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_change_password_without_token_returns_401(client):
    res = await client.post(
        "/api/v1/auth/change-password",
        json={"current_password": "x", "new_password": "brand-new-password"},
    )
    assert res.status_code == 401


# ── Rate limits (SMS cost defence) ──────────────────────────────────


@pytest.mark.asyncio
async def test_otp_request_rate_limited_after_hourly_cap(client):
    """After MAX_OTP_REQUESTS_PER_HOUR, /auth/otp/request returns 429."""
    from app.config import get_settings

    phone = make_phone()  # unique-per-test phone → clean rate bucket
    settings = get_settings()
    # Fire N successful requests up to the limit.
    for i in range(settings.MAX_OTP_REQUESTS_PER_HOUR):
        res = await client.post("/api/v1/auth/otp/request", json={"phone": phone})
        assert res.status_code == 200, f"burn-in request {i} failed: {res.text}"
    # The next one must be blocked.
    over = await client.post("/api/v1/auth/otp/request", json={"phone": phone})
    assert over.status_code == 429
    body = over.json()
    assert body["error"]["code"] == "RATE_LIMITED"


@pytest.mark.asyncio
async def test_forgot_password_rate_limited_after_hourly_cap(client):
    """/auth/forgot-password shares the same identifier bucket — an
    attacker can't grind through a scraped email list at scale."""
    from app.config import get_settings

    phone = make_phone()
    user, _ = await register_diner(client, label="fp-rl", phone=phone)
    settings = get_settings()
    for i in range(settings.MAX_OTP_REQUESTS_PER_HOUR):
        res = await client.post(
            "/api/v1/auth/forgot-password", json={"identifier": user["email"]}
        )
        assert res.status_code == 200, f"burn-in request {i} failed"
    over = await client.post(
        "/api/v1/auth/forgot-password", json={"identifier": user["email"]}
    )
    assert over.status_code == 429


@pytest.mark.asyncio
async def test_rate_limit_bucket_normalises_case_and_whitespace(client):
    """Bucket key normalises whitespace + case so 'You@Ex.com' and
    'you@ex.com  ' share the same window — otherwise attacker gets a
    free multiplier per identifier permutation."""
    from app.config import get_settings

    phone = make_phone()
    user, _ = await register_diner(client, label="fp-norm", phone=phone)
    settings = get_settings()
    variants = [
        user["email"].upper(),
        user["email"].capitalize(),
        f"  {user['email']}  ",
        user["email"],
    ]
    hits = 0
    for v in variants:
        for _ in range(2):  # 2 per variant × 4 variants = 8 total attempts
            res = await client.post(
                "/api/v1/auth/forgot-password", json={"identifier": v}
            )
            if res.status_code == 200:
                hits += 1
            if hits > settings.MAX_OTP_REQUESTS_PER_HOUR:
                pytest.fail("bucket didn't normalise — got past the cap")
        if hits > settings.MAX_OTP_REQUESTS_PER_HOUR:
            break
    # At least one request must have been blocked given 8 > cap of 5.
    assert hits <= settings.MAX_OTP_REQUESTS_PER_HOUR


@pytest.mark.asyncio
async def test_reset_with_noop_request_id_returns_401(client):
    """A synthesised noop-* request_id must always fail — that's the
    whole point of the enumeration-hardening path."""
    forgot = await client.post(
        "/api/v1/auth/forgot-password",
        json={"identifier": "unknown@example.com"},
    )
    request_id = forgot.json()["request_id"]
    res = await client.post(
        "/api/v1/auth/reset-password",
        json={
            "request_id": request_id,
            "code": "000000",
            "new_password": "brand-new-password",
        },
    )
    assert res.status_code == 401
