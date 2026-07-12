"""Tests for POST /auth/google — the Google Identity Services flow.

The Google JWT verifier is a network call to fetch JWKs. We can't
hit the real service in tests, so every test monkey-patches
`verify_google_id_token` to return a canned `GoogleClaims`
regardless of the token bytes. That's exactly the seam the router
uses, so we exercise the account-lookup + linking + creation logic
end to end without a real Google round-trip.

Coverage:
  1. Fresh sub → creates a brand-new diner account with the Google
     email + display_name, verified.
  2. Same sub second time → returns the same user (no dupes).
  3. Existing password account with the same email → linked; the
     new user's google_sub is populated.
  4. Malformed token (verifier raises) → 401 with structured detail.
  5. GOOGLE_CLIENT_ID unset → 503 (feature not configured), not 500.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models.user import User as UserModel
from app.services import google_auth
from app.services.google_auth import GoogleClaims, InvalidGoogleToken
from tests.conftest import make_email


def _fake_claims(email: str, sub: str, name: str | None = "Test Google User"):
    return GoogleClaims(
        sub=sub,
        email=email,
        email_verified=True,
        name=name,
        picture=None,
    )


@pytest.fixture(autouse=True)
def enable_google_client_id(monkeypatch):
    """Point the config at a fake client_id so the router doesn't
    503 on the "not configured" path. Individual tests can override."""
    from app.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "GOOGLE_CLIENT_ID", "test-google-client.apps.googleusercontent.com")
    yield


@pytest.mark.asyncio
async def test_google_signin_creates_new_account(client, db, monkeypatch):
    """First-time Google sign-in mints a fresh diner user with the
    Google email + display name, and the returned JWT works for
    subsequent /auth/me calls."""
    email = make_email("google-new")
    monkeypatch.setattr(
        google_auth,
        "verify_google_id_token",
        lambda token, *, client_id: _fake_claims(email, sub="g-new-sub-001", name="Grace New"),
    )

    res = await client.post(
        "/api/v1/auth/google",
        json={"id_token": "fake.jwt.token.value.long.enough.to.pass.pydantic"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["user"]["email"] == email
    assert body["user"]["display_name"] == "Grace New"
    assert body["user"]["role"] == "diner"
    assert body["token"]

    # /auth/me works with the returned JWT.
    me = await client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {body['token']}"},
    )
    assert me.status_code == 200
    assert me.json()["email"] == email


@pytest.mark.asyncio
async def test_google_signin_returns_same_user_on_repeat(client, db, monkeypatch):
    """A second sign-in with the same sub returns the same user_id —
    no dupes, no 409, no email conflict."""
    email = make_email("google-repeat")
    monkeypatch.setattr(
        google_auth,
        "verify_google_id_token",
        lambda token, *, client_id: _fake_claims(email, sub="g-repeat-sub-002"),
    )

    first = await client.post(
        "/api/v1/auth/google",
        json={"id_token": "fake.jwt.first.attempt.padding.padding.padding"},
    )
    assert first.status_code == 200
    second = await client.post(
        "/api/v1/auth/google",
        json={"id_token": "fake.jwt.second.attempt.padding.padding.padding"},
    )
    assert second.status_code == 200
    assert first.json()["user"]["id"] == second.json()["user"]["id"]


@pytest.mark.asyncio
async def test_google_signin_links_to_existing_password_account(
    client, db, monkeypatch
):
    """A diner who signed up with email + password months ago clicks
    "Continue with Google" for the first time. We must link their
    google_sub to the existing row rather than create a duplicate
    account under the same email (which would violate the email
    UNIQUE constraint anyway)."""
    from app.security import hash_password

    email = make_email("google-linkable")
    existing = UserModel(
        email=email,
        display_name="Existing Password User",
        password_hash=hash_password("plate-clean-demo"),
        role="diner",
    )
    db.add(existing)
    db.commit()
    original_id = str(existing.id)

    monkeypatch.setattr(
        google_auth,
        "verify_google_id_token",
        lambda token, *, client_id: _fake_claims(
            email, sub="g-linkable-sub-003", name="Doesn't Overwrite"
        ),
    )
    res = await client.post(
        "/api/v1/auth/google",
        json={"id_token": "fake.jwt.link.attempt.padding.padding.padding"},
    )
    assert res.status_code == 200
    # Same user_id — link, not create.
    assert res.json()["user"]["id"] == original_id
    # Display_name was preserved (we don't overwrite when there's
    # already one on file). Only NULL display_names get populated.
    assert res.json()["user"]["display_name"] == "Existing Password User"

    # DB row now carries the google_sub — subsequent Google sign-ins
    # go through path 1, not path 2. Expire the sync-session cache
    # so we re-read what the async request handler committed.
    db.expire_all()
    linked = db.execute(
        select(UserModel).where(UserModel.email == email)
    ).scalar_one()
    assert linked.google_sub == "g-linkable-sub-003"
    # Password still works.
    good_login = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "plate-clean-demo"},
    )
    assert good_login.status_code == 200


@pytest.mark.asyncio
async def test_google_signin_invalid_token_returns_401(client, db, monkeypatch):
    """Verifier raises → we return 401 with structured detail. The
    frontend switches on the code, not the message."""
    def _boom(_token, *, client_id):
        raise InvalidGoogleToken("Token used too early")

    monkeypatch.setattr(google_auth, "verify_google_id_token", _boom)
    res = await client.post(
        "/api/v1/auth/google",
        json={"id_token": "fake.jwt.malformed.padding.padding.padding.padding"},
    )
    assert res.status_code == 401
    body = res.json()
    assert body["detail"]["code"] == "INVALID_GOOGLE_TOKEN"


@pytest.mark.asyncio
async def test_google_signin_503_when_client_id_missing(client, monkeypatch):
    """No GOOGLE_CLIENT_ID configured → 503. The frontend renders
    "Google sign-in isn't set up yet" and falls back to email +
    password. Distinct from a 500 so uptime dashboards don't page."""
    from app.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "GOOGLE_CLIENT_ID", "")
    res = await client.post(
        "/api/v1/auth/google",
        json={"id_token": "fake.jwt.will.not.reach.verifier.padding.padding"},
    )
    assert res.status_code == 503
    assert res.json()["detail"]["code"] == "GOOGLE_NOT_CONFIGURED"
