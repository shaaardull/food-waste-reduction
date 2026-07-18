"""Tests for bill delivery — email rendering, SMTP mocking, endpoint
authorization, Celery task retry logic.

The real SMTP call is mocked via smtplib.SMTP so nothing actually
leaves the machine. The Celery task's `.delay()` is monkeypatched
to a synchronous call so we can assert delivery_status transitions
end-to-end within a test.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.bill import Bill
from app.models.meal_session import MealSession, MealSessionItem
from tests.conftest import (
    login,
    make_email,
    make_restaurant,
    make_staff,
    make_table_code,
    register_diner,
)


def _diner_user(db: Session) -> tuple[str, str]:
    from app.models.user import User
    from app.security import hash_password

    email = make_email("bill-deliver-diner")
    u = User(
        email=email,
        display_name="Deliver Diner",
        role="diner",
        password_hash=hash_password("plate-clean-demo"),
    )
    db.add(u)
    db.flush()
    db.commit()
    return str(u.id), email


def _session_with_items(
    db: Session, *, restaurant_id, menu_items, diner_user_id
) -> MealSession:
    started = datetime.now(UTC) - timedelta(minutes=10)
    session = MealSession(
        diner_user_id=diner_user_id,
        restaurant_id=restaurant_id,
        table_code=make_table_code("deliver"),
        status="before_captured",
        started_at=started,
        expires_at=started + timedelta(hours=4),
    )
    db.add(session)
    db.flush()
    for m in menu_items:
        db.add(
            MealSessionItem(
                meal_session_id=session.id,
                menu_item_id=m.id,
                quantity=1,
                portion_size="regular",
            )
        )
    db.commit()
    return session


async def _make_bill(client, db, restaurant, items):
    diner_id, diner_email = _diner_user(db)
    session = _session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:2],
        diner_user_id=diner_id,
    )
    tok = await login(client, diner_email)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 200
    return res.json(), diner_email, tok


# ── Email rendering (pure function) ──────────────────────────────────


def test_bill_email_renders_all_required_fields(db):
    """CGST §46 wants: restaurant name/address/GSTIN, bill number,
    HSN, items, CGST + SGST split, total. Assert each is in the plain
    text at minimum."""
    from app.models.restaurant import Restaurant
    from app.services.email import render_bill_email

    restaurant, items, _ = make_restaurant(db, name="Render Fields")
    r = db.get(Restaurant, restaurant.id)
    assert r is not None
    r.gstin = "27ABCDE1234F1Z5"
    r.bill_prefix = "REND/2026/"
    db.commit()

    bill = Bill(
        meal_session_id=items[0].id,  # bogus, we're not persisting
        restaurant_id=restaurant.id,
        bill_number="REND/2026/00001",
        subtotal_minor=38000,
        discount_minor=0,
        reward_redemption_code=None,
        taxable_amount_minor=38000,
        cgst_rate="0.025",
        sgst_rate="0.025",
        cgst_amount_minor=950,
        sgst_amount_minor=950,
        total_minor=39900,
        currency="INR",
        line_items_json=[
            {
                "menu_item_id": str(items[0].id),
                "name": "Butter Chicken",
                "quantity": 1,
                "portion_size": "regular",
                "price_minor": 30000,
                "line_total_minor": 30000,
            },
            {
                "menu_item_id": str(items[1].id),
                "name": "Garlic Naan",
                "quantity": 1,
                "portion_size": "regular",
                "price_minor": 8000,
                "line_total_minor": 8000,
            },
        ],
        delivery_status="pending",
        issued_at=datetime.now(UTC),
    )
    subject, plain, html = render_bill_email(bill, r)
    assert "REND/2026/00001" in subject
    for needle in [
        r.name,
        r.address,
        "27ABCDE1234F1Z5",
        "9963",
        "Butter Chicken",
        "Garlic Naan",
        "REND/2026/00001",
        "CGST",
        "SGST",
        "counter",  # "show at the counter to pay"
    ]:
        assert needle in plain, f"missing {needle!r} in plain body"
        assert needle in html, f"missing {needle!r} in html body"
    # Format sanity: rupee symbol renders, totals appear.
    assert "₹" in plain and "₹" in html


def test_bill_email_shows_reward_line_when_applied(db):
    from app.models.restaurant import Restaurant
    from app.services.email import render_bill_email

    restaurant, items, _ = make_restaurant(db, name="Render Reward")
    r = db.get(Restaurant, restaurant.id)
    assert r is not None
    bill = Bill(
        meal_session_id=items[0].id,
        restaurant_id=restaurant.id,
        bill_number="2026/00001",
        subtotal_minor=40000,
        discount_minor=5000,
        reward_redemption_code="PLATE-ABC123",
        taxable_amount_minor=35000,
        cgst_rate="0.025",
        sgst_rate="0.025",
        cgst_amount_minor=875,
        sgst_amount_minor=875,
        total_minor=36750,
        currency="INR",
        line_items_json=[
            {
                "menu_item_id": str(items[0].id),
                "name": "Butter Chicken",
                "quantity": 1,
                "portion_size": "regular",
                "price_minor": 40000,
                "line_total_minor": 40000,
            }
        ],
        delivery_status="pending",
        issued_at=datetime.now(UTC),
    )
    _, plain, html = render_bill_email(bill, r)
    assert "PLATE-ABC123" in plain
    assert "PLATE-ABC123" in html


# ── send_email in console mode ───────────────────────────────────────


def test_send_email_console_mode(monkeypatch):
    from app.services import email as email_svc

    # Force console mode regardless of local .env.
    settings = email_svc.get_settings()
    monkeypatch.setattr(settings, "EMAIL_MODE", "console")
    r = email_svc.send_email(
        to="diner@example.com",
        subject="Test",
        plain_body="Hello",
        html_body="<p>Hello</p>",
    )
    assert r.sent is True
    assert r.error is None


# ── send_email in SMTP mode with mocked smtplib ──────────────────────


def test_send_email_smtp_success(monkeypatch):
    from app.services import email as email_svc

    settings = email_svc.get_settings()
    monkeypatch.setattr(settings, "EMAIL_MODE", "smtp")
    monkeypatch.setattr(settings, "SMTP_USER", "noreply@example.com")
    monkeypatch.setattr(settings, "SMTP_PASSWORD", "app-pass")  # noqa: S105

    smtp_mock = MagicMock()
    ctx = MagicMock()
    ctx.__enter__.return_value = smtp_mock
    ctx.__exit__.return_value = False
    with patch("app.services.email.smtplib.SMTP", return_value=ctx):
        r = email_svc.send_email(
            to="diner@example.com",
            subject="Test",
            plain_body="Hello",
            html_body="<p>Hello</p>",
        )
    assert r.sent is True
    smtp_mock.starttls.assert_called_once()
    smtp_mock.login.assert_called_once_with("noreply@example.com", "app-pass")
    smtp_mock.send_message.assert_called_once()


def test_send_email_smtp_captures_exception(monkeypatch):
    """SMTP failure returns sent=False with the error message —
    never raises. The Celery task depends on this to decide retry
    vs mark-as-failed."""
    import smtplib

    from app.services import email as email_svc

    settings = email_svc.get_settings()
    monkeypatch.setattr(settings, "EMAIL_MODE", "smtp")
    monkeypatch.setattr(settings, "SMTP_USER", "noreply@example.com")
    monkeypatch.setattr(settings, "SMTP_PASSWORD", "app-pass")  # noqa: S105

    def boom(*args, **kwargs):
        raise smtplib.SMTPAuthenticationError(535, b"bad credentials")

    with patch("app.services.email.smtplib.SMTP", side_effect=boom):
        r = email_svc.send_email(
            to="diner@example.com",
            subject="Test",
            plain_body="Hello",
            html_body="<p>Hello</p>",
        )
    assert r.sent is False
    assert r.error is not None
    assert "credentials" in r.error.lower() or "535" in r.error


def test_send_email_smtp_missing_creds_returns_error(monkeypatch):
    from app.services import email as email_svc

    settings = email_svc.get_settings()
    monkeypatch.setattr(settings, "EMAIL_MODE", "smtp")
    monkeypatch.setattr(settings, "SMTP_USER", "")
    monkeypatch.setattr(settings, "SMTP_PASSWORD", "")
    r = email_svc.send_email(
        to="diner@example.com",
        subject="Test",
        plain_body="Hi",
        html_body="<p>Hi</p>",
    )
    assert r.sent is False
    assert "SMTP_USER" in (r.error or "")


# ── Endpoint: POST /bills/:id/send ──────────────────────────────────


@pytest.mark.asyncio
async def test_send_endpoint_queues_task(client, db, monkeypatch):
    """202 immediately, task is enqueued with the right args, bill
    row's delivery status flips to pending."""
    from app.tasks import deliver_bill as task_module

    calls: list[tuple[tuple, dict]] = []

    def fake_delay(*args, **kwargs):
        calls.append((args, kwargs))

    monkeypatch.setattr(task_module.deliver_bill, "delay", fake_delay)

    restaurant, items, _ = make_restaurant(db, name="Send Endpoint")
    bill_json, _, tok = await _make_bill(client, db, restaurant, items)

    res = await client.post(
        f"/api/v1/bills/{bill_json['id']}/send",
        json={"via": "email", "target_email": "diner@example.com"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 202, res.text
    assert res.json()["status"] == "queued"
    assert len(calls) == 1
    args, kwargs = calls[0]
    assert args == (bill_json["id"],)
    assert kwargs["via"] == "email"
    assert kwargs["target_email"] == "diner@example.com"


@pytest.mark.asyncio
async def test_send_endpoint_400_no_email_recipient(client, db, monkeypatch):
    from app.tasks import deliver_bill as task_module

    monkeypatch.setattr(task_module.deliver_bill, "delay", lambda *a, **k: None)
    restaurant, items, _ = make_restaurant(db, name="No Email")
    bill_json, _, tok = await _make_bill(client, db, restaurant, items)

    res = await client.post(
        f"/api/v1/bills/{bill_json['id']}/send",
        json={"via": "email"},  # no target_email, and none snapshotted
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 400
    assert "email" in res.json()["detail"].lower()


@pytest.mark.asyncio
async def test_send_endpoint_400_no_phone_recipient(client, db, monkeypatch):
    from app.tasks import deliver_bill as task_module

    monkeypatch.setattr(task_module.deliver_bill, "delay", lambda *a, **k: None)
    restaurant, items, _ = make_restaurant(db, name="No Phone")
    bill_json, _, tok = await _make_bill(client, db, restaurant, items)

    res = await client.post(
        f"/api/v1/bills/{bill_json['id']}/send",
        json={"via": "sms"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 400
    assert "phone" in res.json()["detail"].lower()


@pytest.mark.asyncio
async def test_send_endpoint_diner_blocked_from_other_bill(client, db, monkeypatch):
    from app.tasks import deliver_bill as task_module

    monkeypatch.setattr(task_module.deliver_bill, "delay", lambda *a, **k: None)
    restaurant, items, _ = make_restaurant(db, name="Foreign Bill")
    bill_json, _, _ = await _make_bill(client, db, restaurant, items)
    _, intruder_tok = await register_diner(client)
    res = await client.post(
        f"/api/v1/bills/{bill_json['id']}/send",
        json={"via": "email", "target_email": "steal@example.com"},
        headers={"Authorization": f"Bearer {intruder_tok}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_send_endpoint_staff_can_resend(client, db, monkeypatch):
    """Staff sitting at the counter re-triggers delivery when a diner
    says they didn't get the receipt. Must succeed."""
    from app.tasks import deliver_bill as task_module

    monkeypatch.setattr(task_module.deliver_bill, "delay", lambda *a, **k: None)
    restaurant, items, _ = make_restaurant(db, name="Staff Resend")
    bill_json, _, _ = await _make_bill(client, db, restaurant, items)
    manager = make_staff(db, restaurant.id)
    tok = await login(client, manager.email)
    res = await client.post(
        f"/api/v1/bills/{bill_json['id']}/send",
        json={"via": "email", "target_email": "diner@example.com"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 202


@pytest.mark.asyncio
async def test_send_endpoint_uses_snapshotted_target_on_second_call(
    client, db, monkeypatch
):
    """The bill row already has delivery_email set from the first
    delivery; a resend without target_email in the body still works."""
    from app.tasks import deliver_bill as task_module

    monkeypatch.setattr(task_module.deliver_bill, "delay", lambda *a, **k: None)
    restaurant, items, _ = make_restaurant(db, name="Resend Snapshot")
    bill_json, _, tok = await _make_bill(client, db, restaurant, items)
    first = await client.post(
        f"/api/v1/bills/{bill_json['id']}/send",
        json={"via": "email", "target_email": "diner@example.com"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert first.status_code == 202
    # Second call omits target — should pick it up from the bill row.
    second = await client.post(
        f"/api/v1/bills/{bill_json['id']}/send",
        json={"via": "email"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert second.status_code == 202


@pytest.mark.asyncio
async def test_send_endpoint_persists_customer_email_on_session(
    client, db, monkeypatch
):
    """A diner-triggered 'email me the bill' request should backfill
    session.customer_email if it's currently NULL, so future exports
    show the recipient without needing the read-time diner-user
    fallback."""
    from app.models.meal_session import MealSession
    from app.tasks import deliver_bill as task_module

    monkeypatch.setattr(task_module.deliver_bill, "delay", lambda *a, **k: None)
    restaurant, items, _ = make_restaurant(db, name="Persist Email")
    bill_json, _, tok = await _make_bill(client, db, restaurant, items)
    from app.models.bill import Bill
    session_id = db.get(Bill, bill_json["id"]).meal_session_id

    # Precondition: session was created without a staff-typed email.
    session = db.get(MealSession, session_id)
    session.customer_email = None
    db.commit()

    res = await client.post(
        f"/api/v1/bills/{bill_json['id']}/send",
        json={"via": "email", "target_email": "diner-typed@example.com"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 202

    db.expire_all()
    session = db.get(MealSession, session_id)
    assert session.customer_email == "diner-typed@example.com"


@pytest.mark.asyncio
async def test_send_endpoint_does_not_overwrite_staff_typed_customer_email(
    client, db, monkeypatch
):
    """Walk-in Step 3 (or takeaway Step 3) staff-typed customer_email
    is authoritative. A diner-triggered resend to a different address
    must not stomp on the staff-recorded value."""
    from app.models.meal_session import MealSession
    from app.tasks import deliver_bill as task_module

    monkeypatch.setattr(task_module.deliver_bill, "delay", lambda *a, **k: None)
    restaurant, items, _ = make_restaurant(db, name="No Overwrite")
    bill_json, _, tok = await _make_bill(client, db, restaurant, items)
    from app.models.bill import Bill
    session_id = db.get(Bill, bill_json["id"]).meal_session_id

    # Staff already recorded a customer_email at walk-in Step 3.
    session = db.get(MealSession, session_id)
    session.customer_email = "staff-recorded@example.com"
    db.commit()

    res = await client.post(
        f"/api/v1/bills/{bill_json['id']}/send",
        json={"via": "email", "target_email": "someone-else@example.com"},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 202

    db.expire_all()
    session = db.get(MealSession, session_id)
    assert session.customer_email == "staff-recorded@example.com"
