"""msg91 client — Indian DLT-compliant SMS gateway.

CLAUDE.md §10 lists `OTP_PROVIDER=msg91` as the prod default. This
module implements that provider. The API surface is intentionally
small: one function per transactional SMS class (`send_otp`,
`send_reward`, `send_bill`), each accepting the recipient phone plus
the variables that plug into the corresponding DLT-registered
template.

The three call sites are:

* `services/otp.py` — signup + login OTP  (template MSG91_OTP_TEMPLATE_ID)
* `services/otp.py` — password-reset OTP  (template MSG91_RESET_TEMPLATE_ID)
* `services/sms.py` — reward code SMS     (template MSG91_REWARD_TEMPLATE_ID)
* `services/email.py::send_bill_sms_stub` — bill SMS (template MSG91_BILL_TEMPLATE_ID)

Delivery is best-effort and never raises. A gateway failure logs and
returns False so the caller can continue with the DB-side commit
(the diner already has the reward / OTP entry / bill in Postgres —
losing the SMS on top is degraded but not catastrophic).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from app.config import get_settings
from app.logging import get_logger

log = get_logger(__name__)


@dataclass(frozen=True)
class SmsSendResult:
    """Small value object so callers can distinguish "no gateway
    configured yet" (retryable-by-config) from "gateway rejected the
    request" (retryable-by-user or actual bug)."""

    sent: bool
    provider_message_id: str | None = None
    error: str | None = None


def normalize_phone_for_msg91(phone: str) -> str:
    """msg91 wants a country-code-prefixed E.164 number WITHOUT the
    leading `+`. Examples:

        +91 98765 43210  →  919876543210
        91 9876543210     →  919876543210
        9876543210        →  919876543210 (assumed India for the pilot)

    Anything shorter than 10 digits gets returned unchanged — msg91
    will 400 it and we'll log the failure with the raw input for
    debugging.
    """
    digits = "".join(ch for ch in phone if ch.isdigit())
    if not digits:
        return phone
    # If they already carry a country code, keep it. India numbers
    # are 10 digits national; with the 91 country code they're 12.
    if len(digits) >= 11:
        return digits
    if len(digits) == 10:
        # Pilot is India-only. Once we expand, this default becomes a
        # per-restaurant `country_code` on the DB row.
        return "91" + digits
    return digits


def _post_flow(
    *, template_id: str, phone: str, variables: dict[str, str]
) -> SmsSendResult:
    """Low-level flow POST — the shape every msg91 transactional SMS
    call uses. Variables map to the template's ``##varN##`` slots.

    Returns SmsSendResult so tests can assert on request shape without
    the caller having to peek at msg91's raw response dict.
    """
    settings = get_settings()
    if not settings.MSG91_AUTH_KEY:
        return SmsSendResult(
            sent=False, error="MSG91_AUTH_KEY not configured"
        )
    if not template_id:
        return SmsSendResult(sent=False, error="template_id missing")

    payload: dict[str, Any] = {
        "template_id": template_id,
        # Turn off msg91's URL shortener — we don't ship any links in
        # our current templates and short URLs get flagged as spam.
        "short_url": "0",
        "recipients": [
            {"mobiles": normalize_phone_for_msg91(phone), **variables}
        ],
    }
    if settings.MSG91_SENDER_ID:
        payload["sender"] = settings.MSG91_SENDER_ID

    url = f"{settings.MSG91_BASE_URL.rstrip('/')}/api/v5/flow/"
    headers = {
        "authkey": settings.MSG91_AUTH_KEY,
        "content-type": "application/json",
        "accept": "application/json",
    }
    try:
        with httpx.Client(timeout=settings.MSG91_TIMEOUT_SECONDS) as client:
            r = client.post(url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        log.error(
            "msg91_http_error",
            template_id=template_id,
            phone=phone,
            error=str(exc),
        )
        return SmsSendResult(sent=False, error=f"http_error: {exc}")

    # msg91 returns 200 + a JSON body like:
    #   {"type": "success", "message": "abcd-1234-request-id"}
    # or on error:
    #   {"type": "error", "message": "Invalid Auth Key"}
    if r.status_code >= 400:
        log.error(
            "msg91_http_status",
            template_id=template_id,
            phone=phone,
            status=r.status_code,
            body=r.text[:500],
        )
        return SmsSendResult(sent=False, error=f"status_{r.status_code}")

    try:
        data = r.json()
    except ValueError:
        log.error(
            "msg91_invalid_json",
            template_id=template_id,
            body=r.text[:500],
        )
        return SmsSendResult(sent=False, error="invalid_json_response")

    status_type = str(data.get("type", "")).lower()
    if status_type == "success":
        message_id = data.get("message") or data.get("request_id")
        log.info(
            "msg91_sent",
            template_id=template_id,
            phone=phone,
            message_id=message_id,
        )
        return SmsSendResult(sent=True, provider_message_id=message_id)

    err = str(data.get("message") or "unknown_error")
    log.error(
        "msg91_rejected",
        template_id=template_id,
        phone=phone,
        error=err,
    )
    return SmsSendResult(sent=False, error=err)


# ── High-level helpers, one per template ────────────────────────────


def send_otp(phone: str, code: str) -> SmsSendResult:
    """Signup / login OTP. Template variable: ##var1## = the 6-digit
    code. Configure MSG91_OTP_TEMPLATE_ID in the msg91 dashboard with
    something like: "Your Plate-Clean verification code is ##var1##.
    Valid for 5 minutes. Do not share."""
    settings = get_settings()
    return _post_flow(
        template_id=settings.MSG91_OTP_TEMPLATE_ID,
        phone=phone,
        variables={"var1": code},
    )


def send_reset_otp(phone: str, code: str) -> SmsSendResult:
    """Password-reset OTP. Falls back to the login-OTP template when a
    dedicated reset template isn't configured — same wording is fine
    for both. Template variable: ##var1## = the 6-digit code."""
    settings = get_settings()
    template_id = (
        settings.MSG91_RESET_TEMPLATE_ID or settings.MSG91_OTP_TEMPLATE_ID
    )
    return _post_flow(
        template_id=template_id,
        phone=phone,
        variables={"var1": code},
    )


def send_reward(phone: str, code: str, restaurant_name: str) -> SmsSendResult:
    """Anonymous / phone-only reward delivery.

    Template variables:
        ##var1## = restaurant_name  (e.g. "Spice Trail")
        ##var2## = redemption_code  (e.g. "PLATE-4E43")

    Suggested template body:
        "Your Plate-Clean reward at ##var1##: code ##var2##.
        Show at the counter to redeem."
    """
    settings = get_settings()
    return _post_flow(
        template_id=settings.MSG91_REWARD_TEMPLATE_ID,
        phone=phone,
        variables={"var1": restaurant_name, "var2": code},
    )


def send_bill(
    phone: str,
    *,
    restaurant_name: str,
    bill_number: str,
    total: str,
) -> SmsSendResult:
    """Bill notification SMS.

    Template variables:
        ##var1## = restaurant_name
        ##var2## = bill_number
        ##var3## = total (already-formatted rupee string, e.g. "₹724.50")

    Suggested template body:
        "Your bill at ##var1##: ##var2##. Total ##var3##.
        Show at counter to pay."
    """
    settings = get_settings()
    return _post_flow(
        template_id=settings.MSG91_BILL_TEMPLATE_ID,
        phone=phone,
        variables={
            "var1": restaurant_name,
            "var2": bill_number,
            "var3": total,
        },
    )
