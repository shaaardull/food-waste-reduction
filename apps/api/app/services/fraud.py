from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.fraud_signal import FraudSignal


async def record(
    db: AsyncSession,
    *,
    signal_type: str,
    severity: str,
    details: dict[str, Any],
    meal_session_id: UUID | None = None,
    user_id: UUID | None = None,
) -> FraudSignal:
    signal = FraudSignal(
        meal_session_id=meal_session_id,
        user_id=user_id,
        signal_type=signal_type,
        severity=severity,
        details=details,
    )
    db.add(signal)
    await db.flush()
    return signal
