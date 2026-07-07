from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.errors import NotRestaurantStaff
from app.models.consumption_score import ConsumptionScore
from app.models.dispute import Dispute
from app.models.fraud_signal import FraudSignal
from app.models.bill import Bill
from app.models.meal_session import MealSession, MealSessionItem
from app.models.menu_item import MenuItem
from app.models.plate_capture import PlateCapture
from app.models.restaurant import Restaurant, RestaurantStaff
from app.models.reward import Reward
from app.models.staff_metrics import StaffMetricsSnapshot
from app.models.staff_validation import StaffValidation
from app.models.user import User
from app.security import get_current_user
from app.services import storage
from app.services import sustainability as sustainability_svc
from app.services import sustainability_report as sustainability_report_svc
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


# Statuses that qualify a session as "still in progress" for the
# Orders dashboard. Ordered by the column they map to on the frontend
# so any status_rank sort below produces column-consistent groupings.
_ACTIVE_ORDER_STATUSES = (
    "open",
    "before_captured",
    "eating",
    "after_submitted",
    "pending_staff_validation",
)


@router.get("/restaurants/{restaurant_id}/dashboard/orders")
async def list_live_orders(
    restaurant_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Live-orders board. Returns every meal session at this restaurant
    that's still in play — from "just placed an order" all the way
    through "waiting for staff validation".

    The dashboard groups them into four columns client-side:
      NEW ORDERS     status='open' + items + kitchen_ack_at IS NULL
      PREPARING      status='open' + items + kitchen_ack_at IS NOT NULL
      EATING         status='before_captured'
      READY TO CLAIM status IN ('after_submitted','pending_staff_validation')

    Rooted on `started_at ASC` so oldest orders sit at the top of each
    column. Only sessions that have at least one item pass through the
    NEW/PREPARING columns; a session in `open` with zero items is a
    diner who hasn't ordered yet and there's nothing for the kitchen
    to see.
    """
    await _ensure_staff(db, user, restaurant_id)
    if (await db.get(Restaurant, restaurant_id)) is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    # Pull sessions in one query; join item rows separately so we don't
    # explode the row count with a cross join.
    sess_res = await db.execute(
        select(MealSession)
        .where(
            MealSession.restaurant_id == restaurant_id,
            MealSession.status.in_(_ACTIVE_ORDER_STATUSES),
        )
        .order_by(MealSession.started_at.asc())
    )
    sessions = list(sess_res.scalars().all())
    if not sessions:
        return {"orders": []}

    session_ids = [s.id for s in sessions]

    # Items per session, joined to menu_items to grab display names.
    items_res = await db.execute(
        select(MealSessionItem, MenuItem)
        .join(MenuItem, MealSessionItem.menu_item_id == MenuItem.id)
        .where(MealSessionItem.meal_session_id.in_(session_ids))
    )
    items_by_session: dict[UUID, list[dict[str, Any]]] = {}
    for msi, menu in items_res.all():
        items_by_session.setdefault(msi.meal_session_id, []).append(
            {
                "menu_item_id": str(menu.id),
                "name": menu.name,
                "quantity": msi.quantity,
                "portion_size": msi.portion_size,
                "notes": msi.notes,
            }
        )

    # Bill status per session — LEFT JOIN, so sessions without a bill
    # simply return None fields. The frontend renders a "No bill" chip
    # in that case and lets staff click to generate.
    bills_res = await db.execute(
        select(Bill).where(Bill.meal_session_id.in_(session_ids))
    )
    bills_by_session: dict[UUID, Bill] = {}
    for b in bills_res.scalars().all():
        bills_by_session[b.meal_session_id] = b

    now = datetime.now(UTC)
    out: list[dict[str, Any]] = []
    for s in sessions:
        items = items_by_session.get(s.id, [])
        # `open` sessions without items don't belong on the board — the
        # diner hasn't chosen anything yet.
        if s.status == "open" and not items:
            continue
        bill = bills_by_session.get(s.id)
        out.append(
            {
                "session_id": str(s.id),
                "table_code": s.table_code,
                "status": s.status,
                "items": items,
                "started_at": s.started_at.isoformat(),
                "started_seconds_ago": int(
                    (now - s.started_at).total_seconds()
                ),
                "kitchen_ack_at": (
                    s.kitchen_ack_at.isoformat() if s.kitchen_ack_at else None
                ),
                "bill_id": str(bill.id) if bill else None,
                "bill_number": bill.bill_number if bill else None,
                "bill_delivery_status": bill.delivery_status if bill else None,
                "bill_total_minor": bill.total_minor if bill else None,
                "bill_sent_at": (
                    bill.sent_at.isoformat() if bill and bill.sent_at else None
                ),
            }
        )
    return {"orders": out}


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


def _percentile(values: list[int], pct: float) -> int | None:
    """Linear-interpolation percentile. Returns ms (int) or None for empty list.

    Used for the decision-latency p50/p95 on the analytics page. We don't
    push this to Postgres because (a) we want it to work the same across
    sqlite/postgres in tests, and (b) the input set is small — bounded by
    sessions in the window.
    """
    if not values:
        return None
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * pct
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    frac = k - lo
    return int(s[lo] + (s[hi] - s[lo]) * frac)


@router.get("/restaurants/{restaurant_id}/dashboard/analytics")
async def analytics(
    restaurant_id: UUID,
    range: str = Query(default="7d", pattern="^(7d|30d|90d)$"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Restaurant analytics blob: counts, rates, decision latency, top
    dishes by consumption, fraud-signal histogram, and aggregate
    sustainability impact for the period.

    All numbers are scoped to `restaurant_id`. Staff of the restaurant
    (any role) or platform admin can read it. Nothing exposes diner PII.
    """
    await _ensure_staff(db, user, restaurant_id)
    days = {"7d": 7, "30d": 30, "90d": 90}[range]
    since = datetime.now(UTC) - timedelta(days=days)

    # ── Session counts by status ───────────────────────────────────────
    sessions_count = await db.scalar(
        select(func.count(MealSession.id)).where(
            MealSession.restaurant_id == restaurant_id,
            MealSession.started_at >= since,
        )
    ) or 0
    pending_count = await db.scalar(
        select(func.count(MealSession.id)).where(
            MealSession.restaurant_id == restaurant_id,
            MealSession.status == "pending_staff_validation",
        )
    ) or 0

    # ── Validation decisions in the window ────────────────────────────
    decision_rows = await db.execute(
        select(StaffValidation.decision, func.count(StaffValidation.id)).where(
            StaffValidation.restaurant_id == restaurant_id,
            StaffValidation.decided_at >= since,
        ).group_by(StaffValidation.decision)
    )
    by_decision: dict[str, int] = {d: int(c) for d, c in decision_rows.all()}
    approved = by_decision.get("approved", 0)
    adjusted = by_decision.get("adjusted", 0)
    rejected = by_decision.get("rejected", 0)
    decided = approved + adjusted + rejected
    approval_rate = (
        round((approved + adjusted) / decided, 3) if decided else None
    )

    # ── Rewards issued + redeemed in the window ───────────────────────
    rewards_issued = await db.scalar(
        select(func.count(Reward.id))
        .join(MealSession, MealSession.id == Reward.meal_session_id)
        .where(
            MealSession.restaurant_id == restaurant_id,
            Reward.issued_at >= since,
        )
    ) or 0
    rewards_redeemed = await db.scalar(
        select(func.count(Reward.id))
        .join(MealSession, MealSession.id == Reward.meal_session_id)
        .where(
            MealSession.restaurant_id == restaurant_id,
            Reward.issued_at >= since,
            Reward.redeemed_at.is_not(None),
        )
    ) or 0
    redemption_rate = (
        round(rewards_redeemed / rewards_issued, 3) if rewards_issued else None
    )

    # ── Avg final score in the window ─────────────────────────────────
    avg_score = await db.scalar(
        select(func.avg(StaffValidation.final_score)).where(
            StaffValidation.restaurant_id == restaurant_id,
            StaffValidation.decided_at >= since,
        )
    )

    # ── Decision latency (in-Python percentile — set is bounded) ─────
    latency_rows = await db.execute(
        select(StaffValidation.decision_latency_ms).where(
            StaffValidation.restaurant_id == restaurant_id,
            StaffValidation.decided_at >= since,
        )
    )
    latencies = [int(row[0]) for row in latency_rows.all() if row[0] is not None]

    # ── Top 5 dishes by avg final_score (approved/adjusted sessions) ──
    top_dish_rows = await db.execute(
        select(
            MenuItem.id,
            MenuItem.name,
            MenuItem.category,
            func.count(MealSessionItem.id).label("orders"),
            func.avg(StaffValidation.final_score).label("avg_score"),
        )
        .join(MealSessionItem, MealSessionItem.menu_item_id == MenuItem.id)
        .join(MealSession, MealSession.id == MealSessionItem.meal_session_id)
        .join(StaffValidation, StaffValidation.meal_session_id == MealSession.id)
        .where(
            MealSession.restaurant_id == restaurant_id,
            StaffValidation.decided_at >= since,
            StaffValidation.decision.in_(("approved", "adjusted")),
        )
        .group_by(MenuItem.id, MenuItem.name, MenuItem.category)
        .order_by(func.avg(StaffValidation.final_score).desc(), func.count(MealSessionItem.id).desc())
        .limit(5)
    )
    top_dishes = [
        {
            "menu_item_id": str(row.id),
            "name": row.name,
            "category": row.category,
            "orders": int(row.orders),
            "avg_final_score": round(float(row.avg_score), 3),
        }
        for row in top_dish_rows.all()
    ]

    # ── Fraud signals grouped by type + severity ──────────────────────
    fraud_rows = await db.execute(
        select(
            FraudSignal.signal_type,
            FraudSignal.severity,
            func.count(FraudSignal.id),
        )
        .join(MealSession, MealSession.id == FraudSignal.meal_session_id)
        .where(
            MealSession.restaurant_id == restaurant_id,
            FraudSignal.created_at >= since,
        )
        .group_by(FraudSignal.signal_type, FraudSignal.severity)
    )
    by_signal: dict[str, dict[str, int]] = {}
    for signal_type, severity, count in fraud_rows.all():
        by_signal.setdefault(signal_type, {"info": 0, "warning": 0, "block": 0})
        by_signal[signal_type][severity] = int(count)
    fraud_signals = [
        {
            "signal_type": t,
            "severity_counts": counts,
            "total": sum(counts.values()),
        }
        for t, counts in sorted(by_signal.items(), key=lambda kv: -sum(kv[1].values()))
    ]

    # ── Aggregate sustainability for the restaurant ───────────────────
    sustainability_rows = await db.execute(
        select(
            StaffValidation.meal_session_id,
            StaffValidation.final_score,
            MealSessionItem.quantity,
            MenuItem.category,
        )
        .join(MealSession, MealSession.id == StaffValidation.meal_session_id)
        .join(MealSessionItem, MealSessionItem.meal_session_id == MealSession.id)
        .join(MenuItem, MenuItem.id == MealSessionItem.menu_item_id)
        .where(
            MealSession.restaurant_id == restaurant_id,
            StaffValidation.decided_at >= since,
            StaffValidation.decision.in_(("approved", "adjusted")),
        )
    )
    # Group by session_id so each session contributes once with its full item list.
    by_session: dict[UUID, tuple[Decimal, list[tuple[str | None, int]]]] = {}
    for session_id, final_score, quantity, category in sustainability_rows.all():
        score = Decimal(str(final_score))
        if session_id not in by_session:
            by_session[session_id] = (score, [])
        by_session[session_id][1].append((category, int(quantity)))
    sustain_input = [
        sustainability_svc.SessionInput(final_score=score, item_categories=items)
        for score, items in by_session.values()
    ]
    sustain_report = sustainability_svc.compute(sustain_input, period_days=days)

    return {
        "range": range,
        "period_days": days,
        "totals": {
            "sessions": sessions_count,
            "approved": approved,
            "adjusted": adjusted,
            "rejected": rejected,
            "decided": decided,
            "pending_validation": pending_count,
            "rewards_issued": rewards_issued,
            "rewards_redeemed": rewards_redeemed,
        },
        "rates": {
            "approval_rate": approval_rate,
            "redemption_rate": redemption_rate,
        },
        "avg_final_score": float(avg_score) if avg_score is not None else None,
        "decision_latency_ms": {
            "p50": _percentile(latencies, 0.50),
            "p95": _percentile(latencies, 0.95),
            "count": len(latencies),
        },
        "top_dishes": top_dishes,
        "fraud_signals": fraud_signals,
        "sustainability": {
            "kg_food_saved": sustain_report.kg_food_saved,
            "kg_co2e_saved": sustain_report.kg_co2e_saved,
            "trees_day_equivalent": sustain_report.trees_day_equivalent,
            "sessions_counted": sustain_report.sessions_counted,
        },
    }


@router.get(
    "/restaurants/{restaurant_id}/dashboard/sustainability-report.pdf",
    response_class=Response,
)
async def sustainability_report_pdf(
    restaurant_id: UUID,
    range: str = Query(default="30d", pattern="^(7d|30d|90d)$"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Downloadable PDF sustainability report for a restaurant (Phase 3
    bullet from CLAUDE.md §9). Reuses the same aggregations as the
    JSON analytics endpoint but returns rendered PDF bytes with a
    sensible Content-Disposition so browsers prompt a download."""
    await _ensure_staff(db, user, restaurant_id)
    restaurant = await db.get(Restaurant, restaurant_id)
    if restaurant is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    days = {"7d": 7, "30d": 30, "90d": 90}[range]
    since = datetime.now(UTC) - timedelta(days=days)

    # Session counts (same shape as analytics, but we only keep what the
    # PDF actually shows — totals + top dishes + sustainability stats).
    sessions_count = await db.scalar(
        select(func.count(MealSession.id)).where(
            MealSession.restaurant_id == restaurant_id,
            MealSession.started_at >= since,
        )
    ) or 0

    decision_rows = await db.execute(
        select(StaffValidation.decision, func.count(StaffValidation.id))
        .where(
            StaffValidation.restaurant_id == restaurant_id,
            StaffValidation.decided_at >= since,
        )
        .group_by(StaffValidation.decision)
    )
    by_decision: dict[str, int] = {d: int(c) for d, c in decision_rows.all()}
    approved = by_decision.get("approved", 0)
    adjusted = by_decision.get("adjusted", 0)
    rejected = by_decision.get("rejected", 0)

    rewards_issued = await db.scalar(
        select(func.count(Reward.id))
        .join(MealSession, MealSession.id == Reward.meal_session_id)
        .where(
            MealSession.restaurant_id == restaurant_id,
            Reward.issued_at >= since,
        )
    ) or 0
    rewards_redeemed = await db.scalar(
        select(func.count(Reward.id))
        .join(MealSession, MealSession.id == Reward.meal_session_id)
        .where(
            MealSession.restaurant_id == restaurant_id,
            Reward.issued_at >= since,
            Reward.redeemed_at.is_not(None),
        )
    ) or 0

    top_dish_rows = await db.execute(
        select(
            MenuItem.name,
            MenuItem.category,
            func.count(MealSessionItem.id).label("orders"),
            func.avg(StaffValidation.final_score).label("avg_score"),
        )
        .join(MealSessionItem, MealSessionItem.menu_item_id == MenuItem.id)
        .join(MealSession, MealSession.id == MealSessionItem.meal_session_id)
        .join(
            StaffValidation, StaffValidation.meal_session_id == MealSession.id
        )
        .where(
            MealSession.restaurant_id == restaurant_id,
            StaffValidation.decided_at >= since,
            StaffValidation.decision.in_(("approved", "adjusted")),
        )
        .group_by(MenuItem.name, MenuItem.category)
        .order_by(
            func.avg(StaffValidation.final_score).desc(),
            func.count(MealSessionItem.id).desc(),
        )
        .limit(5)
    )
    top_dishes = [
        sustainability_report_svc.TopDish(
            name=row.name,
            category=row.category,
            orders=int(row.orders),
            avg_consumption=float(row.avg_score),
        )
        for row in top_dish_rows.all()
    ]

    # Sustainability: same compute path as the JSON endpoint.
    sustainability_rows = await db.execute(
        select(
            StaffValidation.meal_session_id,
            StaffValidation.final_score,
            MealSessionItem.quantity,
            MenuItem.category,
        )
        .join(MealSession, MealSession.id == StaffValidation.meal_session_id)
        .join(MealSessionItem, MealSessionItem.meal_session_id == MealSession.id)
        .join(MenuItem, MenuItem.id == MealSessionItem.menu_item_id)
        .where(
            MealSession.restaurant_id == restaurant_id,
            StaffValidation.decided_at >= since,
            StaffValidation.decision.in_(("approved", "adjusted")),
        )
    )
    by_session: dict[UUID, tuple[Decimal, list[tuple[str | None, int]]]] = {}
    for session_id, final_score, quantity, category in sustainability_rows.all():
        score = Decimal(str(final_score))
        if session_id not in by_session:
            by_session[session_id] = (score, [])
        by_session[session_id][1].append((category, int(quantity)))
    sustain_input = [
        sustainability_svc.SessionInput(final_score=score, item_categories=items)
        for score, items in by_session.values()
    ]
    sustain = sustainability_svc.compute(sustain_input, period_days=days)

    pdf_bytes = sustainability_report_svc.render_pdf(
        sustainability_report_svc.ReportInputs(
            restaurant_name=restaurant.name,
            restaurant_slug=restaurant.slug,
            period_days=days,
            generated_at=datetime.now(UTC),
            kg_food_saved=sustain.kg_food_saved,
            kg_co2e_saved=sustain.kg_co2e_saved,
            trees_day_equivalent=sustain.trees_day_equivalent,
            sustainability_sessions_counted=sustain.sessions_counted,
            sessions=int(sessions_count),
            approved=approved,
            adjusted=adjusted,
            rejected=rejected,
            rewards_issued=int(rewards_issued),
            rewards_redeemed=int(rewards_redeemed),
            top_dishes=top_dishes,
        )
    )
    filename = (
        f"plate-clean-sustainability-{restaurant.slug}-{range}-"
        f"{datetime.now(UTC).strftime('%Y%m%d')}.pdf"
    )
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, max-age=0, no-cache",
        },
    )


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
