import asyncio
import secrets
from uuid import UUID, uuid4

from app.config import get_settings
from app.logging import get_logger
from app.services.cache import get_redis

log = get_logger(__name__)
settings = get_settings()
OTP_TTL_SECONDS = 5 * 60
RESET_OTP_TTL_SECONDS = 5 * 60


async def request_reset_otp(
    *, user_id: UUID, phone: str | None, email: str | None
) -> tuple[str, list[str]]:
    """Issue a password-reset code for a known user + dispatch it via
    any channel the user has on file. Returns
    (request_id, delivered_channels).

    Distinct from `request_otp` because reset must work for accounts
    that predate the phone-required signup migration (email but no
    phone) — the OTP verify path looks up the user by ID, not phone.

    Delivery is INLINE (not Celery) so a missing worker doesn't
    silently drop the reset email. `asyncio.to_thread` keeps the
    event loop responsive during the 2-3s SMTP round-trip.
    """
    if not phone and not email:
        raise ValueError("reset OTP requires at least one delivery channel")

    code = f"{secrets.randbelow(1_000_000):06d}"
    request_id = str(uuid4())
    r = get_redis()
    # Distinct key prefix from the phone-verify OTP so verify_otp
    # (called from anonymous signup) can't accidentally consume a
    # reset code.
    await r.set(
        f"reset_otp:{request_id}", f"{user_id}|{code}", ex=RESET_OTP_TTL_SECONDS
    )

    delivered: list[str] = []

    # SMS delivery — dev logs to stdout, prod dispatches via msg91.
    if phone:
        if settings.OTP_PROVIDER == "console":
            log.info(
                "reset_otp_sms_console",
                phone=phone,
                code=code,
                request_id=request_id,
            )
            delivered.append("sms")
        elif settings.OTP_PROVIDER == "msg91":
            from app.services.msg91 import send_reset_otp as msg91_send_reset  # noqa: PLC0415

            # msg91 is a sync client (httpx.Client) so we pop it onto a
            # thread — otherwise a slow gateway would stall the FastAPI
            # event loop and hurt every concurrent request.
            result = await asyncio.to_thread(msg91_send_reset, phone, code)
            if result.sent:
                delivered.append("sms")
            else:
                log.error(
                    "reset_otp_sms_failed",
                    phone=phone,
                    request_id=request_id,
                    error=result.error,
                )
        else:
            log.warning(
                "reset_otp_sms_provider_not_implemented",
                provider=settings.OTP_PROVIDER,
            )

    # Email delivery — inline. Never raises; returns SendResult even
    # on failure so we can log clearly and still hand back to the
    # caller.
    if email:
        from app.services.email import (  # noqa: PLC0415
            render_password_reset_email,
            send_email,
        )

        try:
            subject, plain, html = render_password_reset_email(
                email=email, code=code
            )
            result = await asyncio.to_thread(
                send_email,
                to=email,
                subject=subject,
                plain_body=plain,
                html_body=html,
            )
            if result.sent:
                log.info(
                    "reset_otp_email_sent",
                    to=email,
                    request_id=request_id,
                )
                delivered.append("email")
            else:
                log.error(
                    "reset_otp_email_failed",
                    to=email,
                    request_id=request_id,
                    error=result.error,
                )
        except Exception as exc:  # noqa: BLE001 — reset must not crash on email
            log.error(
                "reset_otp_email_unexpected_error",
                to=email,
                request_id=request_id,
                error=str(exc),
            )

    return request_id, delivered


async def verify_reset_otp(request_id: str, code: str) -> UUID | None:
    """Verify a reset-OTP request_id + code pair. Returns the user_id
    the code was issued for on success, None on failure/expiry.

    Single-use: consumes the Redis entry on match so a second attempt
    with the same code fails naturally."""
    r = get_redis()
    key = f"reset_otp:{request_id}"
    stored = await r.get(key)
    if stored is None:
        return None
    user_id_str, expected = stored.split("|", 1)
    if secrets.compare_digest(expected, code):
        await r.delete(key)
        try:
            return UUID(user_id_str)
        except ValueError:
            return None
    return None


async def request_otp(phone: str) -> str:
    """Issue an OTP for phone; returns a request_id the client uses to verify.

    Used by the anonymous quick-start signup path only. Password
    reset uses `request_reset_otp` above — it keys on user_id, not
    phone, so accounts without a phone can still recover.

    In dev with OTP_PROVIDER=console, logs the OTP to stdout. In prod
    this would dispatch via msg91 / twilio.
    """
    code = f"{secrets.randbelow(1_000_000):06d}"
    request_id = str(uuid4())
    r = get_redis()
    await r.set(f"otp:{request_id}", f"{phone}|{code}", ex=OTP_TTL_SECONDS)

    if settings.OTP_PROVIDER == "console":
        log.info("otp_issued", phone=phone, code=code, request_id=request_id)
    elif settings.OTP_PROVIDER == "msg91":
        from app.services.msg91 import send_otp as msg91_send_otp  # noqa: PLC0415

        # Sync client on a worker thread — same reason as reset OTP.
        result = await asyncio.to_thread(msg91_send_otp, phone, code)
        if not result.sent:
            log.error(
                "otp_send_failed",
                phone=phone,
                request_id=request_id,
                error=result.error,
            )
    else:
        log.warning("otp_provider_not_implemented", provider=settings.OTP_PROVIDER)

    return request_id


async def verify_otp(request_id: str, code: str) -> str | None:
    """Returns the verified phone number on success, None otherwise."""
    r = get_redis()
    key = f"otp:{request_id}"
    stored = await r.get(key)
    if stored is None:
        return None
    phone, expected = stored.split("|", 1)
    if secrets.compare_digest(expected, code):
        await r.delete(key)
        return phone
    return None
