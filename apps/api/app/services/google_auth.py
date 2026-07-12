"""Google Identity Services ID token verification.

Thin wrapper over `google-auth`'s official verifier so the auth router
doesn't have to know about JWK fetching or clock-skew tolerance.

Design notes:
- Verification is synchronous + network-bound (fetches Google's JWKs
  on cold cache). Call it via `asyncio.to_thread` from an async
  handler to keep the event loop responsive.
- We deliberately DON'T cache the JWKs ourselves — `google-auth`'s
  `Request` object handles caching internally with the correct
  refresh semantics (Google rotates keys weekly).
- The verifier already checks: signature, issuer (accounts.google.com
  or https://accounts.google.com), audience (our GOOGLE_CLIENT_ID),
  and expiry. We just re-validate email presence + verified flag on
  top for extra defensiveness.
"""
from __future__ import annotations

from dataclasses import dataclass

from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token


class InvalidGoogleToken(ValueError):
    """The token is malformed, expired, wrong-audience, or signed
    by a party we don't trust. Never leak the underlying error to
    the caller — that would be a fingerprinting surface for
    attackers probing our config."""


@dataclass
class GoogleClaims:
    """Subset of the ID-token payload we actually use. Populated
    from a successful verify; nothing else on the token matters to
    us."""

    sub: str          # stable per-user id, never changes
    email: str
    email_verified: bool
    name: str | None
    picture: str | None


def verify_google_id_token(token: str, *, client_id: str) -> GoogleClaims:
    """Verify a Google ID token against the caller-supplied client ID.

    Raises `InvalidGoogleToken` on any failure — including bad
    signature, expired token, wrong audience, or an unverified email.
    An unverified email is a defence-in-depth check: without it, a
    malicious app could get an ID token for `someone-elses@gmail.com`
    that Google issued to a different OAuth client and we'd trust it.
    """
    try:
        payload = google_id_token.verify_oauth2_token(
            token, google_requests.Request(), client_id
        )
    except (ValueError, GoogleAuthError) as exc:  # noqa: F821 — see below
        raise InvalidGoogleToken(str(exc)) from exc

    sub = payload.get("sub")
    email = payload.get("email")
    if not sub or not email:
        raise InvalidGoogleToken("Token missing sub or email claim")

    email_verified = bool(payload.get("email_verified", False))
    if not email_verified:
        # Google issues tokens for unverified emails too — reject
        # them so we don't create accounts under email addresses
        # the caller hasn't proven they own.
        raise InvalidGoogleToken("Google email is not verified")

    return GoogleClaims(
        sub=str(sub),
        email=str(email).lower(),
        email_verified=email_verified,
        name=payload.get("name"),
        picture=payload.get("picture"),
    )


# `google.auth.exceptions.GoogleAuthError` is imported here so the
# except-clause name resolves. Kept at module scope for clarity.
from google.auth.exceptions import GoogleAuthError  # noqa: E402
