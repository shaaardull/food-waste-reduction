"""Waitlist / walk-in queue — integration tests.

Public flow:
  • Submit is unauthed, keyed on restaurant slug.
  • First entry lands at position 1; third when two are still waiting
    lands at 3; position updates as earlier entries are seated.
  • party_size and guest_name are validated with pydantic — 0 / 21
    reject; missing guest_name rejects.
  • The IP-rate-limit is exercised via a monkeypatched limiter — we do
    not actually hammer the endpoint 10 times.

Staff flow:
  • Owner / manager / server can list, seat, cancel, no-show.
  • Cross-restaurant staff get 403 NOT_RESTAURANT_STAFF.
  • Seat is a one-shot transition — a second seat call 409s
    WAITLIST_ENTRY_NOT_WAITING.
"""
from __future__ import annotations

import pytest
from sqlalchemy.orm import Session

from app.models.restaurant import RestaurantStaff
from app.models.user import User
from app.security import hash_password
from tests.conftest import (
    login,
    make_email,
    make_restaurant,
    make_staff,
    register_diner,
)


def _make_server(db: Session, restaurant_id) -> User:
    u = User(
        email=make_email("wait-server"),
        display_name="Test Server",
        role="staff",
        password_hash=hash_password("plate-clean-demo"),
    )
    db.add(u)
    db.flush()
    db.add(RestaurantStaff(user_id=u.id, restaurant_id=restaurant_id, role="server"))
    db.commit()
    return u


async def _submit(client, slug: str, **overrides):
    body = {
        "party_size": 2,
        "guest_name": "Priya",
    }
    body.update(overrides)
    return await client.post(f"/api/v1/restaurants/{slug}/waitlist", json=body)


# ── Public submit ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_public_submit_first_entry_position_one(client, db):
    restaurant, _, _ = make_restaurant(db, name="Wait First")
    res = await _submit(client, restaurant.slug, guest_name="Anaya")
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["position_in_queue"] == 1
    assert body["party_size"] == 2
    assert body["guest_name"] == "Anaya"
    assert "id" in body


@pytest.mark.asyncio
async def test_public_submit_third_entry_position_three(client, db):
    restaurant, _, _ = make_restaurant(db, name="Wait Third")
    await _submit(client, restaurant.slug, guest_name="One")
    await _submit(client, restaurant.slug, guest_name="Two")
    res = await _submit(client, restaurant.slug, guest_name="Three")
    assert res.status_code == 201, res.text
    assert res.json()["position_in_queue"] == 3


@pytest.mark.asyncio
async def test_public_submit_party_size_zero_rejected(client, db):
    restaurant, _, _ = make_restaurant(db, name="Wait PS0")
    res = await _submit(client, restaurant.slug, party_size=0)
    assert res.status_code in (400, 422), res.text


@pytest.mark.asyncio
async def test_public_submit_party_size_twenty_one_rejected(client, db):
    restaurant, _, _ = make_restaurant(db, name="Wait PS21")
    res = await _submit(client, restaurant.slug, party_size=21)
    assert res.status_code in (400, 422), res.text


@pytest.mark.asyncio
async def test_public_submit_missing_guest_name_rejected(client, db):
    restaurant, _, _ = make_restaurant(db, name="Wait NoName")
    res = await client.post(
        f"/api/v1/restaurants/{restaurant.slug}/waitlist",
        json={"party_size": 2},
    )
    assert res.status_code in (400, 422), res.text


@pytest.mark.asyncio
async def test_public_submit_empty_guest_name_rejected(client, db):
    restaurant, _, _ = make_restaurant(db, name="Wait EmptyName")
    res = await _submit(client, restaurant.slug, guest_name="")
    assert res.status_code in (400, 422), res.text


@pytest.mark.asyncio
async def test_public_submit_unknown_slug_404(client):
    res = await client.post(
        "/api/v1/restaurants/does-not-exist-xyz/waitlist",
        json={"party_size": 2, "guest_name": "Ghost"},
    )
    assert res.status_code == 404, res.text


# ── Public GET by id — live position ────────────────────────────────


@pytest.mark.asyncio
async def test_public_get_position_updates_as_earlier_entries_seated(client, db):
    restaurant, _, _ = make_restaurant(db, name="Wait Live Pos")
    a = (await _submit(client, restaurant.slug, guest_name="A")).json()
    b = (await _submit(client, restaurant.slug, guest_name="B")).json()
    c = (await _submit(client, restaurant.slug, guest_name="C")).json()

    poll_c = await client.get(f"/api/v1/waitlist/{c['id']}")
    assert poll_c.status_code == 200
    assert poll_c.json()["position_in_queue"] == 3
    assert poll_c.json()["status"] == "waiting"

    # Seat A → C should move to position 2.
    staff = make_staff(db, restaurant.id)
    tok = await login(client, staff.email)
    seat_a = await client.post(
        f"/api/v1/waitlist/{a['id']}/seat",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert seat_a.status_code == 200
    assert (await client.get(f"/api/v1/waitlist/{c['id']}")).json()[
        "position_in_queue"
    ] == 2

    # Seat B → C is now #1.
    seat_b = await client.post(
        f"/api/v1/waitlist/{b['id']}/seat",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert seat_b.status_code == 200
    assert (await client.get(f"/api/v1/waitlist/{c['id']}")).json()[
        "position_in_queue"
    ] == 1


@pytest.mark.asyncio
async def test_position_for_fourth_after_three_seated(client, db):
    """After 3 entries are seated, the 4th (still waiting) is #1."""
    restaurant, _, _ = make_restaurant(db, name="Wait 4th Pos")
    ids = []
    for name in ("A", "B", "C", "D"):
        r = await _submit(client, restaurant.slug, guest_name=name)
        ids.append(r.json()["id"])

    staff = make_staff(db, restaurant.id)
    tok = await login(client, staff.email)
    for entry_id in ids[:3]:
        r = await client.post(
            f"/api/v1/waitlist/{entry_id}/seat",
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert r.status_code == 200, r.text

    poll = await client.get(f"/api/v1/waitlist/{ids[3]}")
    assert poll.status_code == 200
    body = poll.json()
    assert body["status"] == "waiting"
    assert body["position_in_queue"] == 1


# ── Staff GET / cross-restaurant ────────────────────────────────────


@pytest.mark.asyncio
async def test_staff_get_returns_only_own_restaurant_queue(client, db):
    r_a, _, _ = make_restaurant(db, name="Wait A")
    r_b, _, _ = make_restaurant(db, name="Wait B")
    await _submit(client, r_a.slug, guest_name="At A")
    await _submit(client, r_b.slug, guest_name="At B")

    staff_a = make_staff(db, r_a.id)
    tok = await login(client, staff_a.email)
    res = await client.get(
        f"/api/v1/restaurants/{r_a.id}/waitlist",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 200
    active = res.json()["active"]
    assert len(active) == 1
    assert active[0]["guest_name"] == "At A"


@pytest.mark.asyncio
async def test_cross_restaurant_staff_forbidden_on_list(client, db):
    r_a, _, _ = make_restaurant(db, name="Wait Cross A")
    r_b, _, _ = make_restaurant(db, name="Wait Cross B")
    staff_b = make_staff(db, r_b.id)
    tok = await login(client, staff_b.email)
    res = await client.get(
        f"/api/v1/restaurants/{r_a.id}/waitlist",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "NOT_RESTAURANT_STAFF"


@pytest.mark.asyncio
async def test_server_can_list_queue(client, db):
    restaurant, _, _ = make_restaurant(db, name="Wait Server OK")
    server = _make_server(db, restaurant.id)
    tok = await login(client, server.email)
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/waitlist",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 200


@pytest.mark.asyncio
async def test_diner_forbidden_on_list(client, db):
    restaurant, _, _ = make_restaurant(db, name="Wait Diner Blocked")
    _, diner_token = await register_diner(client, label="wait-diner")
    res = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/waitlist",
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_staff_list_include_recent(client, db):
    restaurant, _, _ = make_restaurant(db, name="Wait Recent")
    entry = (await _submit(client, restaurant.slug, guest_name="Cleared")).json()
    staff = make_staff(db, restaurant.id)
    tok = await login(client, staff.email)
    await client.post(
        f"/api/v1/waitlist/{entry['id']}/seat",
        headers={"Authorization": f"Bearer {tok}"},
    )
    with_recent = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/waitlist?include_recent=true",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert with_recent.status_code == 200
    body = with_recent.json()
    assert body["active"] == []
    assert body["recent"] is not None
    assert any(r["guest_name"] == "Cleared" for r in body["recent"])


# ── Seat / cancel / no-show state transitions ────────────────────────


@pytest.mark.asyncio
async def test_staff_seat_records_status_and_actor(client, db):
    restaurant, _, _ = make_restaurant(db, name="Wait Seat")
    entry = (await _submit(client, restaurant.slug, guest_name="Sit")).json()
    staff = make_staff(db, restaurant.id)
    tok = await login(client, staff.email)
    res = await client.post(
        f"/api/v1/waitlist/{entry['id']}/seat",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "seated"
    assert body["seated_by_user_id"] == str(staff.id)
    assert body["seated_at"] is not None


@pytest.mark.asyncio
async def test_seat_already_seated_returns_409(client, db):
    restaurant, _, _ = make_restaurant(db, name="Wait Reseat")
    entry = (await _submit(client, restaurant.slug, guest_name="Twice")).json()
    staff = make_staff(db, restaurant.id)
    tok = await login(client, staff.email)
    first = await client.post(
        f"/api/v1/waitlist/{entry['id']}/seat",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert first.status_code == 200
    second = await client.post(
        f"/api/v1/waitlist/{entry['id']}/seat",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert second.status_code == 409, second.text
    assert second.json()["error"]["code"] == "WAITLIST_ENTRY_NOT_WAITING"


@pytest.mark.asyncio
async def test_staff_cancel_records_reason(client, db):
    restaurant, _, _ = make_restaurant(db, name="Wait Cancel")
    entry = (await _submit(client, restaurant.slug, guest_name="Left")).json()
    staff = make_staff(db, restaurant.id)
    tok = await login(client, staff.email)
    res = await client.post(
        f"/api/v1/waitlist/{entry['id']}/cancel",
        json={"reason": "changed_their_mind"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "cancelled"
    assert body["cancelled_reason"] == "changed_their_mind"
    assert body["cancelled_at"] is not None


@pytest.mark.asyncio
async def test_staff_no_show(client, db):
    restaurant, _, _ = make_restaurant(db, name="Wait NoShow")
    entry = (await _submit(client, restaurant.slug, guest_name="Gone")).json()
    staff = make_staff(db, restaurant.id)
    tok = await login(client, staff.email)
    res = await client.post(
        f"/api/v1/waitlist/{entry['id']}/no-show",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "no_show"
    assert body["seated_at"] is None


@pytest.mark.asyncio
async def test_cross_restaurant_staff_cannot_seat(client, db):
    r_a, _, _ = make_restaurant(db, name="Wait X-Seat A")
    r_b, _, _ = make_restaurant(db, name="Wait X-Seat B")
    entry = (await _submit(client, r_a.slug, guest_name="Belongs to A")).json()

    staff_b = make_staff(db, r_b.id)
    tok = await login(client, staff_b.email)
    res = await client.post(
        f"/api/v1/waitlist/{entry['id']}/seat",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "NOT_RESTAURANT_STAFF"


# ── Rate limit — mocked ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_public_submit_rate_limit_via_mocked_limiter(client, db, monkeypatch):
    """We don't hammer the endpoint 10 times. Patch the limiter to raise
    once — the router should surface a 429 with RATE_LIMITED."""
    from app.errors import RateLimited
    from app.routers import waitlist as waitlist_router

    restaurant, _, _ = make_restaurant(db, name="Wait RL")

    async def _raise(_ip: str) -> None:
        raise RateLimited(details={"limit": 10, "window": "1h"})

    monkeypatch.setattr(waitlist_router, "_check_public_submit_limit", _raise)

    res = await _submit(client, restaurant.slug, guest_name="Blocked")
    assert res.status_code == 429, res.text
    assert res.json()["error"]["code"] == "RATE_LIMITED"


# ── Guest-side cancel ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_guest_cancel_flips_to_cancelled(client, db):
    restaurant, _, _ = make_restaurant(db, name="Wait Guest Cancel")
    entry = (await _submit(client, restaurant.slug, guest_name="Leaving")).json()
    res = await client.post(
        f"/api/v1/waitlist/{entry['id']}/guest-cancel",
        json={"reason": "guest_cancelled"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "cancelled"
    assert body["cancelled_reason"] == "guest_cancelled"


@pytest.mark.asyncio
async def test_guest_cancel_on_seated_entry_409(client, db):
    """A guest can't retroactively cancel someone else's seated entry —
    the terminal-state guard blocks the flip."""
    restaurant, _, _ = make_restaurant(db, name="Wait Guest Cancel Seated")
    entry = (await _submit(client, restaurant.slug, guest_name="Already Sat")).json()
    staff = make_staff(db, restaurant.id)
    tok = await login(client, staff.email)
    await client.post(
        f"/api/v1/waitlist/{entry['id']}/seat",
        headers={"Authorization": f"Bearer {tok}"},
    )
    res = await client.post(
        f"/api/v1/waitlist/{entry['id']}/guest-cancel",
        json={"reason": "guest_cancelled"},
    )
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "WAITLIST_ENTRY_NOT_WAITING"
