from uuid import UUID

from app.config import get_settings
from app.errors import RateLimited
from app.services.cache import get_redis

settings = get_settings()


async def _incr_with_ttl(key: str, ttl_seconds: int) -> int:
    r = get_redis()
    pipe = r.pipeline()
    pipe.incr(key)
    pipe.expire(key, ttl_seconds, nx=True)
    res = await pipe.execute()
    return int(res[0])


async def check_sessions_per_day(user_id: UUID) -> None:
    key = f"rl:sessions:user:{user_id}:day"
    count = await _incr_with_ttl(key, ttl_seconds=86400)
    if count > settings.MAX_SESSIONS_PER_USER_PER_DAY:
        raise RateLimited(
            details={"limit": settings.MAX_SESSIONS_PER_USER_PER_DAY, "window": "1d"}
        )


async def check_captures_per_hour(user_id: UUID) -> None:
    key = f"rl:captures:user:{user_id}:hour"
    count = await _incr_with_ttl(key, ttl_seconds=3600)
    if count > settings.MAX_CAPTURES_PER_HOUR:
        raise RateLimited(
            details={"limit": settings.MAX_CAPTURES_PER_HOUR, "window": "1h"}
        )


async def check_rewards_per_restaurant_per_day(user_id: UUID, restaurant_id: UUID) -> None:
    key = f"rl:rewards:user:{user_id}:restaurant:{restaurant_id}:day"
    count = await _incr_with_ttl(key, ttl_seconds=86400)
    if count > settings.MAX_REWARDS_PER_RESTAURANT_PER_DAY:
        raise RateLimited(
            details={"limit": settings.MAX_REWARDS_PER_RESTAURANT_PER_DAY, "window": "1d"}
        )


def _otp_key(identifier: str) -> str:
    """Normalise the identifier so 'user@example.com' and
    'User@Example.com' share the same bucket, and phone whitespace
    doesn't split rate windows."""
    return identifier.strip().lower().replace(" ", "")


async def check_otp_requests(identifier: str) -> None:
    """Enforce both hourly and daily caps on OTP-issuing endpoints
    (/auth/otp/request and /auth/forgot-password). We hit both
    windows in one call — the hourly window catches burst abuse,
    the daily window catches slow-drip scraping. Bucket is per
    identifier (phone or email), NOT per IP, because that's what
    actually costs SMS budget."""
    normalised = _otp_key(identifier)
    hour_key = f"rl:otp:{normalised}:hour"
    day_key = f"rl:otp:{normalised}:day"
    hour_count = await _incr_with_ttl(hour_key, ttl_seconds=3600)
    if hour_count > settings.MAX_OTP_REQUESTS_PER_HOUR:
        raise RateLimited(
            details={"limit": settings.MAX_OTP_REQUESTS_PER_HOUR, "window": "1h"}
        )
    day_count = await _incr_with_ttl(day_key, ttl_seconds=86400)
    if day_count > settings.MAX_OTP_REQUESTS_PER_DAY:
        raise RateLimited(
            details={"limit": settings.MAX_OTP_REQUESTS_PER_DAY, "window": "1d"}
        )
