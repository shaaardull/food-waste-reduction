from uuid import UUID

from app.security import new_nonce
from app.services.cache import get_redis


def _key(session_id: UUID, phase: str) -> str:
    return f"nonce:{session_id}:{phase}"


async def issue(session_id: UUID, phase: str, ttl_minutes: int) -> str:
    nonce = new_nonce()
    r = get_redis()
    await r.set(_key(session_id, phase), nonce, ex=ttl_minutes * 60)
    return nonce


async def consume(session_id: UUID, phase: str, presented: str) -> bool:
    """Returns True if the presented nonce matches and is consumed atomically."""
    r = get_redis()
    key = _key(session_id, phase)
    stored = await r.get(key)
    if stored is None or stored != presented:
        return False
    deleted = await r.delete(key)
    return deleted == 1
