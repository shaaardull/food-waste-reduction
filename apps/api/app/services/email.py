"""Email dispatch — SMTP wrapper with a console fallback.

Mirrors the OTP + SMS pattern (`services/otp.py`, `services/sms.py`):
`EMAIL_MODE=console` in dev logs the rendered message to stdout so
you can read the receipt from `docker compose logs api`; `smtp`
actually opens a connection.

For bill delivery specifically:
- The renderer is a plain-format string, not a template engine.
  Dependency-light and the layout doesn't warrant Jinja.
- Content is CGST §46-compliant: restaurant name/address/GSTIN,
  bill number, itemized list, HSN code, CGST + SGST split, total.
- Uses `EmailMessage` (stdlib) with UTF-8 so ₹ + Devanagari render
  cleanly across Gmail, Outlook, Apple Mail.
"""
# ruff: noqa: E501 — the HTML template legitimately uses long inline
# style attributes; wrapping mid-attribute would break CSS parsing
# in Outlook and Gmail. Module-level exemption is cleaner than a
# noqa on every render line.
from __future__ import annotations

import smtplib
from dataclasses import dataclass
from decimal import Decimal
from email.message import EmailMessage
from typing import Any

from app.config import get_settings
from app.logging import get_logger
from app.models.bill import Bill
from app.models.restaurant import Restaurant

log = get_logger(__name__)


@dataclass
class SendResult:
    """Return value from `send_email`. `sent` is the truthiness the
    caller reads; `error` carries the reason on failure so the caller
    can persist it on `bills.delivery_error`."""

    sent: bool
    error: str | None = None


def _format_rupees(minor: int) -> str:
    """paise → '₹1,234.50'. Two-decimal even when the paisa is 00 so
    the bill visually lines up column-wise."""
    rupees = Decimal(minor) / Decimal(100)
    # Manual thousand-separator so we don't depend on locale being set
    # in the container (locale.setlocale is a global side-effect).
    integer_part, _, fractional = f"{rupees:.2f}".partition(".")
    grouped = ""
    while len(integer_part) > 3:
        grouped = "," + integer_part[-3:] + grouped
        integer_part = integer_part[:-3]
    grouped = integer_part + grouped
    return f"₹{grouped}.{fractional}"


def _bill_lines(bill: Bill) -> str:
    """Render the line-items table as fixed-width plain text so the
    plain-text alternative reads well in any client that stripped the
    HTML (or a screen reader)."""
    rows: list[str] = []
    rows.append(f"{'Item':<32}{'Qty':>4}  {'Price':>12}  {'Total':>12}")
    rows.append("-" * 64)
    for it in bill.line_items_json:
        name = str(it["name"])[:32]
        qty = int(it["quantity"])
        price = _format_rupees(int(it["price_minor"]))
        line_total = _format_rupees(int(it["line_total_minor"]))
        rows.append(f"{name:<32}{qty:>4}  {price:>12}  {line_total:>12}")
    return "\n".join(rows)


def render_bill_email(
    bill: Bill, restaurant: Restaurant
) -> tuple[str, str, str]:
    """Return (subject, plain_text_body, html_body).

    HTML uses inline styles because Gmail strips <style>. Plain text
    is a real alternative, not a fallback stub — some diners open
    email in terminal clients."""
    subject = f"Your bill — {restaurant.name} · {bill.bill_number}"

    # ── plain-text body ──
    footer_lines: list[str] = []
    if bill.reward_redemption_code:
        footer_lines.append(
            f"Reward applied ({bill.reward_redemption_code}) — thanks for "
            "finishing what you ordered."
        )
    footer_lines.append(
        "Please show this bill at the counter to pay. Payment is not "
        "handled in the app."
    )
    plain_body = f"""
{restaurant.name}
{restaurant.address}
GSTIN: {restaurant.gstin or 'not provided'}    HSN: {restaurant.hsn_code}

Bill: {bill.bill_number}
Issued: {bill.issued_at.strftime('%d %b %Y, %H:%M')} {restaurant.timezone}

{_bill_lines(bill)}

Subtotal        {_format_rupees(bill.subtotal_minor):>16}
Discount        {_format_rupees(-bill.discount_minor):>16}
Taxable         {_format_rupees(bill.taxable_amount_minor):>16}
CGST ({bill.cgst_rate * 100}%)   {_format_rupees(bill.cgst_amount_minor):>16}
SGST ({bill.sgst_rate * 100}%)   {_format_rupees(bill.sgst_amount_minor):>16}
--------
Total           {_format_rupees(bill.total_minor):>16}

{chr(10).join(footer_lines)}
""".strip()

    # ── HTML body ── inline styles only, safe across mail clients
    reward_line = (
        f'<tr><td style="padding:6px 0;color:#6b7280;font-size:12px;">'
        f'Reward applied ({bill.reward_redemption_code})</td></tr>'
        if bill.reward_redemption_code
        else ""
    )
    row_html = "\n".join(
        f'<tr>'
        f'<td style="padding:6px 0;">{it["name"]}'
        f'{" · " + it["portion_size"] if it.get("portion_size") else ""}</td>'
        f'<td style="padding:6px 0;text-align:center;">{it["quantity"]}</td>'
        f'<td style="padding:6px 0;text-align:right;font-variant-numeric:tabular-nums;">'
        f'{_format_rupees(int(it["price_minor"]))}</td>'
        f'<td style="padding:6px 0;text-align:right;font-variant-numeric:tabular-nums;">'
        f'{_format_rupees(int(it["line_total_minor"]))}</td>'
        f'</tr>'
        for it in bill.line_items_json
    )
    html_body = f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#f6f7f5;font-family:-apple-system,'Hanken Grotesk',Arial,sans-serif;color:#1f2a24;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:28px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;">Tax invoice</div>
    <h1 style="margin:6px 0 0;font-size:22px;font-weight:800;color:#1f2a24;">{restaurant.name}</h1>
    <div style="color:#6b7280;font-size:13px;margin-top:2px;">{restaurant.address}</div>
    <table style="width:100%;margin-top:14px;font-size:12px;color:#6b7280;">
      <tr>
        <td>GSTIN: <span style="color:#1f2a24;">{restaurant.gstin or 'not provided'}</span></td>
        <td style="text-align:right;">HSN: <span style="color:#1f2a24;">{restaurant.hsn_code}</span></td>
      </tr>
      <tr>
        <td>Bill: <span style="color:#1f2a24;font-weight:600;">{bill.bill_number}</span></td>
        <td style="text-align:right;">Issued: <span style="color:#1f2a24;">{bill.issued_at.strftime('%d %b %Y, %H:%M')}</span></td>
      </tr>
    </table>
    <hr style="border:none;border-top:1px dashed #d1d5db;margin:18px 0;">
    <table style="width:100%;font-size:14px;">
      <thead>
        <tr style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.06em;">
          <th style="text-align:left;padding-bottom:6px;">Item</th>
          <th style="text-align:center;padding-bottom:6px;">Qty</th>
          <th style="text-align:right;padding-bottom:6px;">Price</th>
          <th style="text-align:right;padding-bottom:6px;">Total</th>
        </tr>
      </thead>
      <tbody>
        {row_html}
      </tbody>
    </table>
    <hr style="border:none;border-top:1px dashed #d1d5db;margin:18px 0;">
    <table style="width:100%;font-size:14px;">
      <tr><td style="color:#6b7280;">Subtotal</td><td style="text-align:right;font-variant-numeric:tabular-nums;">{_format_rupees(bill.subtotal_minor)}</td></tr>
      {'<tr><td style="color:#6b7280;">Discount</td><td style="text-align:right;font-variant-numeric:tabular-nums;color:#166534;">−' + _format_rupees(bill.discount_minor) + '</td></tr>' if bill.discount_minor > 0 else ''}
      <tr><td style="color:#6b7280;">Taxable</td><td style="text-align:right;font-variant-numeric:tabular-nums;">{_format_rupees(bill.taxable_amount_minor)}</td></tr>
      <tr><td style="color:#6b7280;">CGST @ {bill.cgst_rate * 100}%</td><td style="text-align:right;font-variant-numeric:tabular-nums;">{_format_rupees(bill.cgst_amount_minor)}</td></tr>
      <tr><td style="color:#6b7280;">SGST @ {bill.sgst_rate * 100}%</td><td style="text-align:right;font-variant-numeric:tabular-nums;">{_format_rupees(bill.sgst_amount_minor)}</td></tr>
      <tr><td colspan="2" style="padding-top:12px;"><hr style="border:none;border-top:1px solid #1f2a24;margin:0;"></td></tr>
      <tr><td style="padding-top:6px;font-weight:700;">Total</td><td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:700;font-size:16px;">{_format_rupees(bill.total_minor)}</td></tr>
    </table>
    {reward_line}
    <div style="margin-top:22px;padding:12px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;color:#166534;font-size:13px;">
      Please show this bill at the counter to pay. Payment is not handled inside the Plate-Clean app.
    </div>
  </div>
</body>
</html>"""
    return subject, plain_body, html_body


def send_email(
    *,
    to: str,
    subject: str,
    plain_body: str,
    html_body: str,
) -> SendResult:
    """Blocking send. Called from a Celery task, not from an async
    request handler, so blocking is fine here. Never raises — returns
    a SendResult the caller can persist."""
    settings = get_settings()
    from_addr = settings.EMAIL_FROM_ADDRESS or settings.SMTP_USER or "noreply@localhost"
    from_header = f"{settings.EMAIL_FROM_NAME} <{from_addr}>"

    if settings.EMAIL_MODE == "console":
        # Dev: dump to stdout so the operator can read the bill without
        # a real SMTP connection.
        log.info(
            "email_console",
            to=to,
            subject=subject,
            from_=from_header,
            body_preview=plain_body[:200],
        )
        return SendResult(sent=True)

    # Real send. Any exception here is captured and returned as the
    # error message so the Celery task can log + retry.
    if not settings.SMTP_USER or not settings.SMTP_PASSWORD:
        log.error("email_smtp_misconfigured", to=to)
        return SendResult(
            sent=False,
            error="SMTP_USER / SMTP_PASSWORD missing — cannot send.",
        )

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_header
    msg["To"] = to
    msg.set_content(plain_body, charset="utf-8")
    msg.add_alternative(html_body, subtype="html")

    try:
        with smtplib.SMTP(
            settings.SMTP_HOST, settings.SMTP_PORT, timeout=15
        ) as smtp:
            smtp.ehlo()
            if settings.SMTP_STARTTLS:
                smtp.starttls()
                smtp.ehlo()
            smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            smtp.send_message(msg)
        log.info("email_sent", to=to, subject=subject)
        return SendResult(sent=True)
    except (smtplib.SMTPException, OSError) as exc:
        # Both timeout (OSError) and auth/tls failures (SMTPException).
        log.error("email_send_failed", to=to, error=str(exc))
        return SendResult(sent=False, error=str(exc))


def send_bill_sms_stub(
    *, phone: str, bill: Bill, restaurant: Restaurant
) -> SendResult:
    """SMS side of bill delivery — stubbed to console until msg91 is
    wired (its own sprint, per the roadmap). Delegates to the existing
    console-only pattern in `services/sms.py`."""
    settings = get_settings()
    message = (
        f"Your bill at {restaurant.name}: {bill.bill_number}. "
        f"Total {_format_rupees(bill.total_minor)}. "
        f"Show at counter to pay."
    )
    if settings.OTP_PROVIDER == "console":
        log.info("sms_bill_console", phone=phone, message=message)
        return SendResult(sent=True)
    log.warning(
        "sms_provider_not_implemented",
        provider=settings.OTP_PROVIDER,
        phone=phone,
        bill_number=bill.bill_number,
    )
    return SendResult(
        sent=False, error=f"SMS provider {settings.OTP_PROVIDER} not implemented"
    )


def dispatch_bill_delivery(
    *, bill: Bill, restaurant: Restaurant, via: str,
    target_email: str | None, target_phone: str | None,
) -> dict[str, Any]:
    """One-call orchestrator — picks the right channel(s), collects
    results, returns a summary the caller can persist on the bill row.

    Return shape: {"email_sent": bool, "sms_sent": bool, "error": str | None}
    """
    result: dict[str, Any] = {"email_sent": False, "sms_sent": False, "error": None}
    subject, plain_body, html_body = render_bill_email(bill, restaurant)
    errors: list[str] = []

    if via in ("email", "both"):
        recipient = target_email or bill.delivery_email
        if not recipient:
            errors.append("no email recipient")
        else:
            r = send_email(
                to=recipient,
                subject=subject,
                plain_body=plain_body,
                html_body=html_body,
            )
            result["email_sent"] = r.sent
            if not r.sent and r.error:
                errors.append(f"email: {r.error}")

    if via in ("sms", "both"):
        recipient = target_phone or bill.delivery_phone
        if not recipient:
            errors.append("no phone recipient")
        else:
            r = send_bill_sms_stub(
                phone=recipient, bill=bill, restaurant=restaurant
            )
            result["sms_sent"] = r.sent
            if not r.sent and r.error:
                errors.append(f"sms: {r.error}")

    if errors and not (result["email_sent"] or result["sms_sent"]):
        # Nothing landed on any channel.
        result["error"] = "; ".join(errors)
    elif errors:
        # Partial success (email OK, SMS failed, or vice versa). Log
        # but the caller treats delivery_status as 'sent'.
        log.warning("bill_partial_delivery", errors=errors)
    return result
