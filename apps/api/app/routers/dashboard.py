from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.errors import NotRestaurantStaff
from app.models.dispute import Dispute
from app.models.meal_session import MealSession
from app.models.restaurant import RestaurantStaff
from app.models.staff_validation import StaffValidation
from app.models.user import User
from app.security import get_current_user

router = APIRouter()


async def _ensure_staff(db: AsyncSession, user: User, restaurant_id: UUID) -> None:
    if user.role == "admin":
        return
    if user.role != "staff":
        raise NotRestaurantStaff()
    res = await db.execute(
        select(RestaurantStaff).where(
            RestaurantStaff.user_id == user.id,
            RestaurantStaff.restaurant_id == restaurant_id,
        )
    )
    if res.scalar_one_or_none() is None:
        raise NotRestaurantStaff()


@router.get("/restaurants/{restaurant_id}/dashboard/summary")
async def summary(
    restaurant_id: UUID,
    range: str = Query(default="7d", pattern="^(7d|30d|90d)$"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    await _ensure_staff(db, user, restaurant_id)
    days = {"7d": 7, "30d": 30, "90d": 90}[range]
    since = datetime.now(UTC) - timedelta(days=days)

    sessions_count = await db.scalar(
        select(func.count(MealSession.id)).where(
            MealSession.restaurant_id == restaurant_id, MealSession.started_at >= since
        )
    )
    rewarded_count = await db.scalar(
        select(func.count(MealSession.id)).where(
            MealSession.restaurant_id == restaurant_id,
            MealSession.status == "rewarded",
            MealSession.started_at >= since,
        )
    )
    rejected_count = await db.scalar(
        select(func.count(MealSession.id)).where(
            MealSession.restaurant_id == restaurant_id,
            MealSession.status == "staff_rejected",
            MealSession.started_at >= since,
        )
    )
    pending_count = await db.scalar(
        select(func.count(MealSession.id)).where(
            MealSession.restaurant_id == restaurant_id,
            MealSession.status == "pending_staff_validation",
        )
    )
    avg_score = await db.scalar(
        select(func.avg(StaffValidation.final_score)).where(
            StaffValidation.restaurant_id == restaurant_id, StaffValidation.decided_at >= since
        )
    )

    return {
        "range": range,
        "sessions": sessions_count or 0,
        "rewarded": rewarded_count or 0,
        "rejected": rejected_count or 0,
        "pending_validation": pending_count or 0,
        "avg_final_score": float(avg_score) if avg_score is not None else None,
    }


@router.get("/restaurants/{restaurant_id}/dashboard/sessions")
async def list_sessions(
    restaurant_id: UUID,
    status_filter: str | None = Query(default=None, alias="status"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[dict[str, Any]]:
    await _ensure_staff(db, user, restaurant_id)
    q = select(MealSession).where(MealSession.restaurant_id == restaurant_id)
    if status_filter:
        q = q.where(MealSession.status == status_filter)
    q = q.order_by(MealSession.started_at.desc()).limit(limit)
    result = await db.execute(q)
    return [
        {
            "id": str(s.id),
            "status": s.status,
            "table_code": s.table_code,
            "started_at": s.started_at.isoformat(),
            "expires_at": s.expires_at.isoformat(),
        }
        for s in result.scalars().all()
    ]


@router.get("/restaurants/{restaurant_id}/dashboard/disputes")
async def list_disputes(
    restaurant_id: UUID,
    status_filter: str = Query(default="open", alias="status"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    await _ensure_staff(db, user, restaurant_id)
    result = await db.execute(
        select(Dispute)
        .join(MealSession, Dispute.meal_session_id == MealSession.id)
        .where(MealSession.restaurant_id == restaurant_id, Dispute.status == status_filter)
        .order_by(Dispute.created_at.desc())
    )
    return [
        {
            "id": str(d.id),
            "meal_session_id": str(d.meal_session_id),
            "reason": d.reason,
            "status": d.status,
            "created_at": d.created_at.isoformat(),
        }
        for d in result.scalars().all()
    ]
