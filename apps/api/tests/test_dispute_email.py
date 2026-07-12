"""Tests for the dispute → support-email pipeline.

Two things this pipeline needs to hold true:

1. The email renderer produces a legible summary the support agent
   can act on — subject line has restaurant + table (front-loaded
   for inbox triage), body carries the reason verbatim, includes the
   dispute + session IDs the dashboard uses as keys, and offers a
   dashboard link.

2. When a diner files a dispute, the row lands in Postgres and the
   Disputes tab endpoint (`/dashboard/disputes?status=open`) surfaces
   it immediately — regardless of whether the email actually landed.
   That guarantee is what lets us make the email async without
   compromising ops visibility.

The Celery `.delay()` call from the router is not asserted here —
CELERY_TASK_ALWAYS_EAGER isn't set in the test bootstrap, so
`.delay()` just enqueues silently. Renderer coverage below plus the
existing `test_create_dispute` in test_sessions_endpoints.py catch
the end-to-end shape.
"""
from __future__ import annotations

import pytest

from app.services.email import render_dispute_email
from tests.conftest import (
    login,
    make_restaurant,
    make_staff,
    register_diner,
)


def test_render_dispute_email_shape():
    subject, plain, html = render_dispute_email(
        dispute_id="d-uuid",
        session_id="s-uuid",
        session_status_before="disputed",
        table_code="T-07",
        reason="The staff rejected me but I cleared the plate.",
        restaurant_name="Konkan Kitchen",
        restaurant_address="Bandra, Mumbai",
        diner_email="diner@example.com",
        diner_phone="+919000000000",
        filed_at_iso="2026-07-08T10:30:00+00:00",
        dashboard_url="https://dashboard/disputes",
    )
    # Subject front-loads the triage keys ops scans by.
    assert "Konkan Kitchen" in subject
    assert "T-07" in subject
    assert "[Plate-Clean]" in subject

    # Plain body has the reason verbatim and the two IDs the
    # dashboard uses as lookup keys.
    assert "The staff rejected me but I cleared the plate." in plain
    assert "d-uuid" in plain
    assert "s-uuid" in plain
    assert "Bandra, Mumbai" in plain
    assert "diner@example.com" in plain
    assert "+919000000000" in plain

    # HTML carries the dashboard CTA — verified as a link and CTA
    # copy so an alternate template can be swapped without breaking
    # the actionability contract.
    assert "https://dashboard/disputes" in html
    assert "Open Disputes tab" in html
    # Reason renders inside the blockquote (visual highlight).
    assert "blockquote" in html


def test_render_dispute_email_handles_missing_contact():
    """A diner may sign up phone-only (email = auto-synthesised) or
    email-only. The renderer must render 'not on file' cleanly rather
    than emit an empty td and break the layout."""
    subject, plain, html = render_dispute_email(
        dispute_id="d-uuid",
        session_id="s-uuid",
        session_status_before="disputed",
        table_code="T-01",
        reason="Photo was too dark to score fairly.",
        restaurant_name="Spice Trail",
        restaurant_address="Andheri, Mumbai",
        diner_email=None,
        diner_phone=None,
        filed_at_iso="2026-07-08T10:30:00+00:00",
        dashboard_url="https://dashboard/disputes",
    )
    assert "not on file" in plain
    assert "not on file" in html
    # Even without contact the subject + core body still renders.
    assert "Spice Trail" in subject


@pytest.mark.asyncio
async def test_dispute_shows_up_on_dashboard_disputes_tab(client, db):
    """The email is a courtesy — the dashboard is the source of truth.
    Filing a dispute must make it visible on the Disputes tab
    (`/dashboard/disputes?status=open`) the moment the API returns."""
    restaurant, _, _ = make_restaurant(db, name="Dispute Tab")
    diner_email, diner_token = None, None
    diner, diner_token = await register_diner(client, label="dispute-tab")
    # Create a bare session directly for the diner — full flow is
    # covered in test_sessions_endpoints; here we just need something
    # for the dispute to hang off.
    session = await client.post(
        "/api/v1/sessions",
        json={"table_code": "T-42", "restaurant_id": str(restaurant.id)},
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert session.status_code == 201, session.text
    session_id = session.json()["session_id"]

    reason_text = "Staff dismissed my after-photo without looking at the plate."
    filed = await client.post(
        f"/api/v1/sessions/{session_id}/dispute",
        json={"reason": reason_text},
        headers={"Authorization": f"Bearer {diner_token}"},
    )
    assert filed.status_code == 201, filed.text
    dispute_id = filed.json()["dispute_id"]

    # Staff logs in and pulls the open disputes list.
    staff = make_staff(db, restaurant.id)
    staff_token = await login(client, staff.email)
    listing = await client.get(
        f"/api/v1/restaurants/{restaurant.id}/dashboard/disputes?status=open",
        headers={"Authorization": f"Bearer {staff_token}"},
    )
    assert listing.status_code == 200, listing.text
    disputes = listing.json()
    ids = [d["id"] for d in disputes]
    assert dispute_id in ids
    # Reason echoes back so staff can triage from the list without
    # a second fetch.
    match = next(d for d in disputes if d["id"] == dispute_id)
    assert match["reason"] == reason_text
    assert match["status"] == "open"
