import secrets
from uuid import uuid4

from app.config import get_settings
from app.logging import get_logger
from app.services.cache import get_redis

log = get_logger(__name__)
settings = get_settings()
OTP_TTL_SECONDS = 5 * 60


async def request_otp(phone: str) -> str:
    """Issue an OTP for phone; returns a request_id the client uses to verify.

    In dev with OTP_PROVIDER=console, logs the OTP to stdout. In prod this
    would dispatch via msg91 / twilio.
    """
    code = f"{secrets.randbelow(1_000_000):06d}"
    request_id = str(uuid4())
    r = get_redis()
    await r.set(f"otp:{request_id}", f"{phone}|{code}", ex=OTP_TTL_SECONDS)

    if settings.OTP_PROVIDER == "console":
        log.info("otp_issued", phone=phone, code=code, request_id=request_id)
    else:
        # Real provider integrations go here (msg91, twilio). Phase 1 stub.
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
