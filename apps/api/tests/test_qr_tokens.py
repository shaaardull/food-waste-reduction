"""Tests for the QR-token inventory + resolve flow.

Coverage:
  • Admin can mint N tokens with a batch label; every returned row
    has a unique 10-char token and state='unassigned'.
  • Admin can bind a token to a restaurant + table; state flips to
    'assigned' and the resolve endpoint carries the pair through.
  • Public /qr/:token/resolve is UNAUTH — a diner scanning a sticker
    doesn't have to be signed in yet.
  • Unknown token → 404 (nothing to resolve).
  • Unassigned / retired tokens → 200 with state field so the client
    can render honest copy rather than a hard error page.
  • Partial unique index blocks two active stickers on the same
    (restaurant, table) pair; retiring the first lets the bind
    succeed.
  • Non-admin callers hit the admin surface and get 404 (URL
    hardening).
"""
from __future__ import annotations

import pytest

from tests.conftest import (
    login,
    make_email,
    make_restaurant,
    register_diner,
)


def _make_admin(db):
    from app.models.user import User as UserModel
    from app.security import hash_password

    u = UserModel(
        email=make_email("qr-admin"),
        display_name="QR Admin",
        role="admin",
        password_hash=hash_password("plate-clean-demo"),
    )
    db.add(u)
    db.commit()
    return u


# ── Batch generation ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_generates_batch_with_label(client, db):
    """POST /admin/platform/qr-tokens returns N unassigned tokens,
    each with the caller-supplied batch label so ops can filter by
    print run."""
    admin = _make_admin(db)
    token = await login(client, admin.email)
    # Use a RUN_TAG-scoped batch label so the teardown catches these
    # (see conftest cleanup for the pattern).
    from tests.conftest import RUN_TAG

    res = await client.post(
        "/api/v1/admin/platform/qr-tokens",
        json={"count": 5, "batch_label": f"itest-{RUN_TAG}-batch-a"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert len(body) == 5
    tokens = {row["token"] for row in body}
    assert len(tokens) == 5, "batch minted duplicate tokens"
    for row in body:
        assert row["state"] == "unassigned"
        assert row["batch_label"] == f"itest-{RUN_TAG}-batch-a"
        # Length invariant so a downstream printer knows what to
        # size the layout around.
        assert len(row["token"]) == 10


@pytest.mark.asyncio
async def test_batch_generation_forbidden_for_non_admin(client, db):
    """Backdoor hardening: staff / diner hitting this URL get 404,
    not 403 — the platform surface is meant to be genuinely hidden."""
    _, diner_token = await register_diner(client, label="qr-snoop")
    res = await client.post(
        "/api/v1/admin/platform/qr-tokens",
        json={"count": 1},
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert res.status_code == 404


# ── Bind + resolve ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bind_and_resolve_round_trip(client, db):
    """Admin binds an unassigned token to a (restaurant, table). The
    public resolve endpoint then returns the exact pair a diner needs
    to open a session — restaurant slug + table code."""
    from tests.conftest import RUN_TAG

    admin = _make_admin(db)
    admin_token = await login(client, admin.email)
    restaurant, _, _ = make_restaurant(db, name="QR Bind Spot")

    # Mint one token to work with.
    minted = await client.post(
        "/api/v1/admin/platform/qr-tokens",
        json={"count": 1, "batch_label": f"itest-{RUN_TAG}-bind"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    token = minted.json()[0]["token"]

    # Bind → assigned.
    bound = await client.post(
        f"/api/v1/admin/platform/qr-tokens/{token}/bind",
        json={
            "restaurant_id": str(restaurant.id),
            "table_code": "T-QR01",
        },
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert bound.status_code == 200, bound.text
    b = bound.json()
    assert b["state"] == "assigned"
    assert b["restaurant_name"] == restaurant.name
    assert b["table_code"] == "T-QR01"
    assert b["assigned_at"] is not None

    # Public resolve — no Authorization header. This is the endpoint
    # the diner PWA hits after scanning the sticker.
    resolved = await client.get(f"/api/v1/qr/{token}/resolve")
    assert resolved.status_code == 200
    r = resolved.json()
    assert r["state"] == "assigned"
    assert r["restaurant_slug"] == restaurant.slug
    assert r["restaurant_name"] == restaurant.name
    assert r["table_code"] == "T-QR01"


@pytest.mark.asyncio
async def test_resolve_unassigned_returns_200_with_state(client, db):
    """Unassigned tokens still return 200 so the client can render a
    "this sticker isn't paired yet" screen rather than a hard error."""
    from tests.conftest import RUN_TAG

    admin = _make_admin(db)
    admin_token = await login(client, admin.email)
    minted = await client.post(
        "/api/v1/admin/platform/qr-tokens",
        json={"count": 1, "batch_label": f"itest-{RUN_TAG}-unbound"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    token = minted.json()[0]["token"]

    res = await client.get(f"/api/v1/qr/{token}/resolve")
    assert res.status_code == 200
    body = res.json()
    assert body["state"] == "unassigned"
    assert body["restaurant_id"] is None
    assert body["table_code"] is None


@pytest.mark.asyncio
async def test_resolve_unknown_token_returns_404(client):
    """An entirely bogus token that was never minted → 404. Different
    from retired (which is 200 + state='retired') so the client can
    show different copy."""
    res = await client.get("/api/v1/qr/NEVERMINTED/resolve")
    assert res.status_code == 404


# ── Constraints ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_two_active_stickers_on_same_table_conflict(client, db):
    """The partial unique index prevents two assigned tokens from
    claiming the same (restaurant, table). Retire the first, and the
    second bind succeeds."""
    from tests.conftest import RUN_TAG

    admin = _make_admin(db)
    admin_token = await login(client, admin.email)
    restaurant, _, _ = make_restaurant(db, name="QR Dup Table")

    minted = await client.post(
        "/api/v1/admin/platform/qr-tokens",
        json={"count": 2, "batch_label": f"itest-{RUN_TAG}-dup"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    token_a, token_b = (row["token"] for row in minted.json())

    # First bind: succeeds.
    first = await client.post(
        f"/api/v1/admin/platform/qr-tokens/{token_a}/bind",
        json={"restaurant_id": str(restaurant.id), "table_code": "T-DUP"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert first.status_code == 200

    # Second bind to the same seat: 409 with structured detail.
    second = await client.post(
        f"/api/v1/admin/platform/qr-tokens/{token_b}/bind",
        json={"restaurant_id": str(restaurant.id), "table_code": "T-DUP"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "ACTIVE_STICKER_EXISTS"

    # Retire the first, then the second bind succeeds.
    retired = await client.post(
        f"/api/v1/admin/platform/qr-tokens/{token_a}/retire",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert retired.status_code == 200
    assert retired.json()["state"] == "retired"

    third = await client.post(
        f"/api/v1/admin/platform/qr-tokens/{token_b}/bind",
        json={"restaurant_id": str(restaurant.id), "table_code": "T-DUP"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert third.status_code == 200


@pytest.mark.asyncio
async def test_bind_retired_token_returns_409(client, db):
    """A retired token can't be re-bound — retire is terminal. A
    404-and-print-a-fresh-sticker is the intended workflow."""
    from tests.conftest import RUN_TAG

    admin = _make_admin(db)
    admin_token = await login(client, admin.email)
    restaurant, _, _ = make_restaurant(db, name="QR Retire")
    minted = await client.post(
        "/api/v1/admin/platform/qr-tokens",
        json={"count": 1, "batch_label": f"itest-{RUN_TAG}-retire"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    token = minted.json()[0]["token"]

    await client.post(
        f"/api/v1/admin/platform/qr-tokens/{token}/retire",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    bind_res = await client.post(
        f"/api/v1/admin/platform/qr-tokens/{token}/bind",
        json={"restaurant_id": str(restaurant.id), "table_code": "T-X"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert bind_res.status_code == 409
    assert bind_res.json()["detail"]["code"] == "TOKEN_RETIRED"
