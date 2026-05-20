from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.errors import NotRestaurantStaff
from app.models.consumption_score import ConsumptionScore
from app.models.meal_session import MealSession
from app.models.menu_item import MenuItem
from app.models.restaurant import RestaurantStaff
from app.models.reward import REWARD_TYPES, Reward, RewardRule
from app.models.user import User
from app.security import get_current_user

router = APIRouter()


def _reward_dict(reward: Reward) -> dict[str, Any]:
    return {
        "id": str(reward.id),
        "redemption_code": reward.redemption_code,
        "reward_type": reward.reward_type,
        "value_minor": reward.value_minor,
        "issued_at": reward.issued_at.isoformat(),
        "half_value_at": reward.half_value_at.isoformat(),
        "expires_at": reward.expires_at.isoformat(),
        "redeemed_at": reward.redeemed_at.isoformat() if reward.redeemed_at else None,
        "redeemed_value_minor": reward.redeemed_value_minor,
        "voided_at": reward.voided_at.isoformat() if reward.voided_at else None,
        "voided_reason": reward.voided_reason,
    }


def _current_value(reward: Reward, now: datetime) -> int:
    """Apply the §12 half-value rule: full value < half_value_at, half between
    half_value_at and expires_at, zero after expires_at."""
    if now >= reward.expires_at:
        return 0
    if now >= reward.half_value_at:
        return reward.value_minor // 2
    return reward.value_minor


@router.get("", response_model=list[dict])
async def my_rewards(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    now = datetime.now(UTC)
    result = await db.execute(
        select(Reward, MealSession)
        .join(MealSession, Reward.meal_session_id == MealSession.id)
        .where(MealSession.diner_user_id == user.id)
        .order_by(Reward.issued_at.desc())
    )
    out: list[dict[str, Any]] = []
    for reward, session in result.all():
        row = _reward_dict(reward)
        row["restaurant_id"] = str(session.restaurant_id)
        row["current_value_minor"] = _current_value(reward, now)
        out.append(row)
    return out


async def _reward_by_code(db: AsyncSession, code: str) -> tuple[Reward, MealSession]:
    res = await db.execute(select(Reward).where(Reward.redemption_code == code))
    reward = res.scalar_one_or_none()
    if reward is None:
        raise HTTPException(status_code=404, detail="Reward not found")
    session = await db.get(MealSession, reward.meal_session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session missing")
    return reward, session


async def _require_staff_for(
    db: AsyncSession, user: User, session: MealSession
) -> None:
    if user.role == "admin":
        return
    if user.role != "staff":
        raise NotRestaurantStaff()
    rs = await db.execute(
        select(RestaurantStaff).where(
            RestaurantStaff.user_id == user.id,
            RestaurantStaff.restaurant_id == session.restaurant_id,
        )
    )
    if rs.scalar_one_or_none() is None:
        raise NotRestaurantStaff()


async def _require_diner_for(user: User, session: MealSession) -> None:
    if session.diner_user_id != user.id:
        raise HTTPException(status_code=403, detail="Not your reward")


@router.get("/{code}")
async def lookup_reward(
    code: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    reward, session = await _reward_by_code(db, code)
    await _require_staff_for(db, user, session)
    score_res = await db.execute(
        select(ConsumptionScore).where(ConsumptionScore.meal_session_id == session.id)
    )
    score = score_res.scalar_one_or_none()
    now = datetime.now(UTC)
    out = _reward_dict(reward)
    out["current_value_minor"] = _current_value(reward, now)
    return {
        "reward": out,
        "session": {
            "id": str(session.id),
            "status": session.status,
            "table_code": session.table_code,
        },
        "score": float(score.overall_score) if score else None,
    }


@router.post("/{code}/choose-type")
async def choose_reward_type(
    code: str,
    payload: dict = Body(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Diner picks between 'menu_item' and 'bill_discount' before redemption.

    §12 decision: customer chooses the reward type. Allowed until the reward
    is redeemed, voided, or expired.
    """
    reward, session = await _reward_by_code(db, code)
    await _require_diner_for(user, session)

    new_type = (payload or {}).get("reward_type")
    if new_type not in REWARD_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"reward_type must be one of {REWARD_TYPES}",
        )

    now = datetime.now(UTC)
    if reward.redeemed_at:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already redeemed")
    if reward.voided_at:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Reward voided")
    if reward.expires_at < now:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Reward expired")

    # Look up the rule so we can enforce allowed_reward_types and recompute
    # value_minor when switching to bill_discount.
    rule = await db.get(RewardRule, reward.reward_rule_id)
    if rule is None:
        raise HTTPException(status_code=500, detail="Reward rule missing")
    if new_type not in (rule.allowed_reward_types or []):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"reward_type '{new_type}' not allowed by this rule",
        )

    if new_type == "menu_item":
        item = await db.get(MenuItem, rule.reward_menu_item_id)
        new_value = item.price_minor if item is not None else reward.value_minor
    else:  # bill_discount
        if rule.bill_discount_minor is not None:
            new_value = rule.bill_discount_minor
        else:
            # Fall back to the menu item's price so the diner isn't punished
            # for picking the discount when the rule omitted an explicit value.
            item = await db.get(MenuItem, rule.reward_menu_item_id)
            new_value = item.price_minor if item is not None else reward.value_minor

    reward.reward_type = new_type
    reward.value_minor = new_value
    await db.commit()
    await db.refresh(reward)

    out = _reward_dict(reward)
    out["current_value_minor"] = _current_value(reward, now)
    return out


@router.post("/{code}/redeem")
async def redeem_reward(
    code: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    reward, session = await _reward_by_code(db, code)
    await _require_staff_for(db, user, session)
    now = datetime.now(UTC)
    if reward.redeemed_at:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already redeemed")
    if reward.voided_at:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Reward voided")
    if reward.expires_at < now:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Reward expired")
    redeemed_value = _current_value(reward, now)
    reward.redeemed_at = now
    reward.redeemed_by_user_id = user.id
    reward.redeemed_value_minor = redeemed_value
    await db.commit()
    await db.refresh(reward)
    out = _reward_dict(reward)
    out["redeemed_value_minor"] = reward.redeemed_value_minor
    return out


@router.post("/{code}/void")
async def void_reward(
    code: str,
    payload: dict = Body(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    reward, session = await _reward_by_code(db, code)
    await _require_staff_for(db, user, session)
    reason = payload.get("reason") if isinstance(payload, dict) else None
    if not reason:
        raise HTTPException(status_code=400, detail="reason required")
    if reward.voided_at:
        return _reward_dict(reward)
    reward.voided_at = datetime.now(UTC)
    reward.voided_reason = reason
    await db.commit()
    await db.refresh(reward)
    return _reward_dict(reward)
