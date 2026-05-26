"""SMS dispatch — pluggable provider switch, mirrors services/otp.py.

CLAUDE.md §9 Phase 3 bullet "Anonymous mode (sessions without account
creation; reward via SMS)". The reward arrives in two channels:

1. The in-app reward screen (the diner stays logged in via the phone-
   OTP token, so /rewards just works).
2. An SMS, in case they close the PWA before staff approves. This
   module owns channel #2.

Provider is selected via the same `OTP_PROVIDER` setting (no need for
a second knob in dev — same fake/real distinction applies). In dev with
`console`, messages are logged to stdout; in prod, msg91/twilio kick in.
"""
from __future__ import annotations

from app.config import get_settings
from app.logging import get_logger

log = get_logger(__name__)


def send_reward_sms(*, phone: str, code: str, restaurant_name: str) -> bool:
    """Deliver the reward SMS to a phone-only diner.

    Returns True if the message was dispatched (or logged in console
    mode), False otherwise. Never raises — the reward must still land
    in the DB even if the SMS gateway is down. The caller logs the
    return value but doesn't roll back.
    """
    settings = get_settings()
    message = (
        f"Your Plate-Clean reward at {restaurant_name}: code {code}. "
        f"Show this to your server to redeem."
    )
    if settings.OTP_PROVIDER == "console":
        log.info("sms_reward", phone=phone, code=code, message=message)
        return True
    # Real provider integrations (msg91 / twilio) go here. For now we
    # log a warning so the operator knows the message wasn't delivered.
    log.warning(
        "sms_provider_not_implemented",
        provider=settings.OTP_PROVIDER,
        phone=phone,
        code=code,
    )
    return False


def is_phone_only_user(user_email: str | None, user_phone: str | None) -> bool:
    """A diner is 'phone-only' when their email is the synthetic placeholder
    we mint in /auth/otp/verify (matches `phone+<digits>@plate-clean.local`).
    Used to decide whether to send the reward SMS — full-account diners
    already see the reward in the PWA and don't need a second copy."""
    if not user_phone:
        return False
    if not user_email:
        return True
    return user_email.startswith("phone+") and user_email.endswith(
        "@plate-clean.local"
    )
