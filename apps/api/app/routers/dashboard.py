from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.errors import NotRestaurantStaff
from app.models.consumption_score import ConsumptionScore
from app.models.dispute import Dispute
from app.models.meal_session import MealSession
from app.models.plate_capture import PlateCapture
from app.models.restaurant import RestaurantStaff
from app.models.staff_metrics import StaffMetricsSnapshot
from app.models.staff_validation import StaffValidation
from app.models.user import User
from app.security import get_current_user
from app.services import storage
from app.tasks.staff_metrics import ALERT_MULTIPLIER, MIN_VALIDATIONS_FOR_ALERT


class DisputeResolveIn(BaseModel):
    status: Literal[
        "resolved_in_favor_diner", "resolved_in_favor_restaurant", "closed"
    ]
    resolution_notes: str | None = Field(default=None, max_length=2000)


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


async def _ensure_owner(
    db: AsyncSession, user: User, restaurant_id: UUID
) -> None:
    """Owner of the restaurant or platform admin only. Resolving a dispute
    is not a server-level action — ethics rule 9 routes disputes to the
    restaurant owner first, platform admin only if unresolved 48h later.
    """
    if user.role == "admin":
        return
    if user.role != "staff":
        raise NotRestaurantStaff()
    res = await db.execute(
        select(RestaurantStaff).where(
            RestaurantStaff.user_id == user.id,
            RestaurantStaff.restaurant_id == restaurant_id,
            RestaurantStaff.role == "owner",
        )
    )
    if res.scalar_one_or_none() is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Owner role required to resolve disputes",
        )


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


@router.get("/restaurants/{restaurant_id}/dashboard/staff-metrics")
async def staff_metrics(
    restaurant_id: UUID,
    weeks: int = Query(default=4, ge=1, le=26),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Per-staff weekly snapshots for ethics-rule-8 oversight.

    Returns one row per staff with their last `weeks` snapshots plus a
    derived `over_threshold` flag (rejection_rate > 2× restaurant median
    AND validations_count >= MIN_VALIDATIONS_FOR_ALERT) so the dashboard
    can colour-code rows the alert job would fire on.
    """
    await _ensure_staff(db, user, restaurant_id)

    rows = list(
        (
            await db.execute(
                select(StaffMetricsSnapshot, User.email, User.display_name)
                .join(User, User.id == StaffMetricsSnapshot.staff_user_id)
                .where(StaffMetricsSnapshot.restaurant_id == restaurant_id)
                .order_by(
                    StaffMetricsSnapshot.staff_user_id.asc(),
                    StaffMetricsSnapshot.period_start.desc(),
                )
            )
        ).all()
    )

    # Group snapshots by staff member, keep most-recent `weeks` per staff.
    by_staff: dict[UUID, dict[str, Any]] = {}
    for snap, email, display_name in rows:
        bucket = by_staff.setdefault(
            snap.staff_user_id,
            {
                "staff_user_id": str(snap.staff_user_id),
                "email": email,
                "display_name": display_name,
                "snapshots": [],
            },
        )
        if len(bucket["snapshots"]) >= weeks:
            continue
        rejection_rate = float(snap.rejection_rate)
        median = float(snap.restaurant_median_rejection_rate)
        over_threshold = (
            snap.validations_count >= MIN_VALIDATIONS_FOR_ALERT
            and rejection_rate > float(ALERT_MULTIPLIER) * median
        )
        bucket["snapshots"].append(
            {
                "period_start": snap.period_start.isoformat(),
                "period_end": snap.period_end.isoformat(),
                "validations_count": snap.validations_count,
                "approvals_count": snap.approvals_count,
                "rejections_count": snap.rejections_count,
                "adjustments_count": snap.adjustments_count,
                "rejection_rate": rejection_rate,
                "approval_rate": float(snap.approval_rate),
                "override_rate": float(
                    (snap.rejections_count + snap.adjustments_count)
                    / snap.validations_count
                )
                if snap.validations_count
                else 0.0,
                "restaurant_median_rejection_rate": median,
                "over_threshold": over_threshold,
            }
        )

    return list(by_staff.values())


@router.get("/restaurants/{restaurant_id}/dashboard/disputes/{dispute_id}")
async def dispute_detail(
    restaurant_id: UUID,
    dispute_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Full review payload for one dispute. Owner/admin only via the same
    _ensure_staff guard as the list endpoint (resolving is owner-only — see
    POST /resolve below)."""
    await _ensure_staff(db, user, restaurant_id)
    dispute = await db.get(Dispute, dispute_id)
    if dispute is None:
        raise HTTPException(status_code=404, detail="Dispute not found")

    session = await db.get(MealSession, dispute.meal_session_id)
    if session is None or session.restaurant_id != restaurant_id:
        # Dispute exists but for a different restaurant — refuse to leak it.
        raise HTTPException(status_code=404, detail="Dispute not found")

    diner = await db.get(User, dispute.raised_by_user_id)
    resolved_by = (
        await db.get(User, dispute.resolved_by_user_id)
        if dispute.resolved_by_user_id
        else None
    )

    score_row = (
        await db.execute(
            select(ConsumptionScore).where(
                ConsumptionScore.meal_session_id == session.id
            )
        )
    ).scalar_one_or_none()

    validation = (
        await db.execute(
            select(StaffValidation).where(
                StaffValidation.meal_session_id == session.id
            )
        )
    ).scalar_one_or_none()

    captures = list(
        (
            await db.execute(
                select(PlateCapture).where(PlateCapture.meal_session_id == session.id)
            )
        ).scalars()
    )
    capture_urls: dict[str, str] = {}
    for c in captures:
        if c.image_s3_key:
            capture_urls[c.phase] = storage.signed_url(c.image_s3_key)

    return {
        "dispute": {
            "id": str(dispute.id),
            "status": dispute.status,
            "reason": dispute.reason,
            "resolution_notes": dispute.resolution_notes,
            "created_at": dispute.created_at.isoformat(),
            "resolved_at": dispute.resolved_at.isoformat()
            if dispute.resolved_at
            else None,
            "resolved_by_user_id": str(dispute.resolved_by_user_id)
            if dispute.resolved_by_user_id
            else None,
        },
        "session": {
            "id": str(session.id),
            "status": session.status,
            "table_code": session.table_code,
            "started_at": session.started_at.isoformat(),
        },
        "diner": {
            "id": str(diner.id),
            "email": diner.email,
            "display_name": diner.display_name,
        }
        if diner
        else None,
        "resolver": {
            "id": str(resolved_by.id),
            "email": resolved_by.email,
            "display_name": resolved_by.display_name,
        }
        if resolved_by
        else None,
        "score": {
            "overall_score": float(score_row.overall_score),
            "model_name": score_row.model_name,
            "notes": score_row.notes,
            "suspicious": bool(score_row.suspicious),
        }
        if score_row
        else None,
        "staff_validation": {
            "decision": validation.decision,
            "final_score": float(validation.final_score),
            "reason_code": validation.reason_code,
            "notes": validation.notes,
            "decided_at": validation.decided_at.isoformat(),
        }
        if validation
        else None,
        "captures": capture_urls,
    }


@router.post(
    "/restaurants/{restaurant_id}/dashboard/disputes/{dispute_id}/resolve",
    status_code=status.HTTP_200_OK,
)
async def resolve_dispute(
    restaurant_id: UUID,
    dispute_id: UUID,
    payload: DisputeResolveIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Owner-only: record a resolution + notes. Idempotent: re-applying the
    same status keeps the original resolver / resolution_notes; a conflicting
    status returns 409 so the audit trail stays clean."""
    await _ensure_owner(db, user, restaurant_id)
    dispute = await db.get(Dispute, dispute_id)
    if dispute is None:
        raise HTTPException(status_code=404, detail="Dispute not found")
    session = await db.get(MealSession, dispute.meal_session_id)
    if session is None or session.restaurant_id != restaurant_id:
        raise HTTPException(status_code=404, detail="Dispute not found")

    if dispute.status != "open":
        if dispute.status == payload.status:
            # Same decision again — no-op.
            return {
                "id": str(dispute.id),
                "status": dispute.status,
                "resolution_notes": dispute.resolution_notes,
                "resolved_at": dispute.resolved_at.isoformat()
                if dispute.resolved_at
                else None,
            }
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Dispute already resolved as {dispute.status}",
        )

    dispute.status = payload.status
    dispute.resolved_by_user_id = user.id
    dispute.resolved_at = datetime.now(UTC)
    if payload.resolution_notes is not None:
        dispute.resolution_notes = payload.resolution_notes
    await db.commit()
    await db.refresh(dispute)
    return {
        "id": str(dispute.id),
        "status": dispute.status,
        "resolution_notes": dispute.resolution_notes,
        "resolved_at": dispute.resolved_at.isoformat() if dispute.resolved_at else None,
    }
