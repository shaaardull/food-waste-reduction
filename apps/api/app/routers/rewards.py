from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.errors import NotRestaurantStaff
from app.models.consumption_score import ConsumptionScore
from app.models.meal_session import MealSession
from app.models.restaurant import RestaurantStaff
from app.models.reward import Reward
from app.models.user import User
from app.security import get_current_user

router = APIRouter()


@router.get("", response_model=list[dict])
async def my_rewards(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    result = await db.execute(
        select(Reward, MealSession)
        .join(MealSession, Reward.meal_session_id == MealSession.id)
        .where(MealSession.diner_user_id == user.id)
        .order_by(Reward.issued_at.desc())
    )
    return [
        {
            "id": str(reward.id),
            "redemption_code": reward.redemption_code,
            "issued_at": reward.issued_at.isoformat(),
            "expires_at": reward.expires_at.isoformat(),
            "redeemed_at": reward.redeemed_at.isoformat() if reward.redeemed_at else None,
            "restaurant_id": str(session.restaurant_id),
        }
        for reward, session in result.all()
    ]


async def _staff_for_code(
    db: AsyncSession, user: User, code: str
) -> tuple[Reward, MealSession]:
    res = await db.execute(select(Reward).where(Reward.redemption_code == code))
    reward = res.scalar_one_or_none()
    if reward is None:
        raise HTTPException(status_code=404, detail="Reward not found")
    session = await db.get(MealSession, reward.meal_session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session missing")
    if user.role not in ("staff", "admin"):
        raise NotRestaurantStaff()
    if user.role == "staff":
        rs = await db.execute(
            select(RestaurantStaff).where(
                RestaurantStaff.user_id == user.id,
                RestaurantStaff.restaurant_id == session.restaurant_id,
            )
        )
        if rs.scalar_one_or_none() is None:
            raise NotRestaurantStaff()
    return reward, session


@router.get("/{code}")
async def lookup_reward(
    code: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    reward, session = await _staff_for_code(db, user, code)
    score_res = await db.execute(
        select(ConsumptionScore).where(ConsumptionScore.meal_session_id == session.id)
    )
    score = score_res.scalar_one_or_none()
    return {
        "reward": {
            "id": str(reward.id),
            "redemption_code": reward.redemption_code,
            "issued_at": reward.issued_at.isoformat(),
            "expires_at": reward.expires_at.isoformat(),
            "redeemed_at": reward.redeemed_at.isoformat() if reward.redeemed_at else None,
            "voided_at": reward.voided_at.isoformat() if reward.voided_at else None,
        },
        "session": {"id": str(session.id), "status": session.status, "table_code": session.table_code},
        "score": float(score.overall_score) if score else None,
    }


@router.post("/{code}/redeem")
async def redeem_reward(
    code: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    reward, session = await _staff_for_code(db, user, code)
    now = datetime.now(timezone.utc)
    if reward.redeemed_at:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already redeemed")
    if reward.voided_at:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Reward voided")
    if reward.expires_at < now:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Reward expired")
    reward.redeemed_at = now
    reward.redeemed_by_user_id = user.id
    await db.commit()
    await db.refresh(reward)
    return {
        "redemption_code": reward.redemption_code,
        "redeemed_at": reward.redeemed_at.isoformat(),
        "redeemed_by_user_id": str(reward.redeemed_by_user_id),
    }


@router.post("/{code}/void")
async def void_reward(
    code: str,
    payload: dict = Body(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    reward, _ = await _staff_for_code(db, user, code)
    reason = payload.get("reason") if isinstance(payload, dict) else None
    if not reason:
        raise HTTPException(status_code=400, detail="reason required")
    if reward.voided_at:
        return {"redemption_code": reward.redemption_code, "voided_at": reward.voided_at.isoformat()}
    reward.voided_at = datetime.now(timezone.utc)
    reward.voided_reason = reason
    await db.commit()
    await db.refresh(reward)
    return {
        "redemption_code": reward.redemption_code,
        "voided_at": reward.voided_at.isoformat(),
        "voided_reason": reward.voided_reason,
    }
