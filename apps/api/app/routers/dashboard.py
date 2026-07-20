from calendar import monthrange
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.session import get_db
from app.errors import NotRestaurantStaff
from app.models.bill import Bill
from app.models.consumption_score import ConsumptionScore
from app.models.dispute import Dispute
from app.models.fraud_signal import FraudSignal
from app.models.meal_session import MealSession, MealSessionItem
from app.models.menu_item import MenuItem
from app.models.plate_capture import PlateCapture
from app.models.restaurant import Restaurant, RestaurantStaff
from app.models.reward import Reward, RewardRule
from app.models.staff_metrics import StaffMetricsSnapshot
from app.models.staff_validation import StaffValidation
from app.models.user import User
from app.security import get_current_user, new_redemption_code
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


async def _ensure_can_resolve_dispute(
    db: AsyncSession,
    user: User,
    restaurant_id: UUID,
) -> None:
    """Flat auth: any staff of the restaurant (owner / manager /
    server) can resolve a dispute. Admins bypass. The per-role
    hierarchy was flattened by product decision — the restaurant
    picks who's trusted at signup time via the staff invite screen,
    not the platform via policy.

    Returns a structured 403 detail so the frontend can render a
    friendly message rather than the raw HTTP status text.
    """
    if user.role == "admin":
        return
    if user.role != "staff":
        raise NotRestaurantStaff()

    membership = await db.execute(
        select(RestaurantStaff).where(
            RestaurantStaff.user_id == user.id,
            RestaurantStaff.restaurant_id == restaurant_id,
        )
    )
    if membership.scalar_one_or_none() is None:
        raise NotRestaurantStaff()


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


# Statuses where a reward decision has been made (or was moot). Used by
# the OrderDetailDrawer to decide whether to render the "Reward" section.
# A session in one of these states has either a linked reward row or a
# structured `reward_outcome` explaining why there isn't one.
_TERMINAL_REWARD_DECISION_STATUSES = (
    "rewarded",
    "staff_approved",
    "staff_rejected",
    "paid",
    "billed",
    "voided",
    "expired",
)


# Statuses that count as a "prior completed visit" for the loyalty
# score. Excludes drive-by QR scans (open/eating/expired) so a diner
# who repeatedly scans and abandons doesn't inflate their tier.
_LOYALTY_COMPLETED_STATUSES = (
    "rewarded",
    "staff_approved",
    "staff_rejected",
    "paid",
)


def _priors_to_loyalty_score(priors: int) -> int:
    """Map completed prior visits → 1..10 tier.

    Floors at 1 so a first-time diner still shows a badge — new
    customers get acknowledged. Caps at 10.
    """
    if priors <= 0:
        return 1
    if priors == 1:
        return 2
    if priors == 2:
        return 3
    if priors <= 4:
        return 4
    if priors <= 6:
        return 5
    if priors <= 8:
        return 6
    if priors <= 11:
        return 7
    if priors <= 15:
        return 8
    if priors <= 20:
        return 9
    return 10


async def _load_loyalty_scores(
    db: AsyncSession,
    sessions: list[MealSession],
) -> dict[UUID, int | None]:
    """Compute loyalty_score per session id for a page of live orders.

    One grouped SELECT across every diner_user_id in the page. Sessions
    without a diner_user_id (walk-ins, takeaways) map to None so the
    frontend renders no badge — this is not a shame indicator, guests
    we don't know just have no score.

    "At this restaurant" — the Live Orders endpoint scopes to one
    restaurant, so all sessions share `restaurant_id`; we still pull it
    from each session to keep the helper self-contained.
    """
    result: dict[UUID, int | None] = {}
    diner_ids: set[UUID] = set()
    for s in sessions:
        if s.diner_user_id is None:
            result[s.id] = None
        else:
            diner_ids.add(s.diner_user_id)
    if not diner_ids:
        return result

    restaurant_ids = {s.restaurant_id for s in sessions}
    current_session_ids = [s.id for s in sessions]
    since = datetime.now(UTC) - timedelta(days=180)

    priors_res = await db.execute(
        select(
            MealSession.diner_user_id,
            func.count(MealSession.id).label("priors"),
        )
        .where(
            MealSession.restaurant_id.in_(restaurant_ids),
            MealSession.diner_user_id.in_(diner_ids),
            MealSession.status.in_(_LOYALTY_COMPLETED_STATUSES),
            MealSession.started_at >= since,
            MealSession.id.notin_(current_session_ids),
        )
        .group_by(MealSession.diner_user_id)
    )
    priors_by_diner: dict[UUID, int] = {
        diner_id: int(count) for diner_id, count in priors_res.all()
    }
    for s in sessions:
        if s.diner_user_id is not None:
            result[s.id] = _priors_to_loyalty_score(
                priors_by_diner.get(s.diner_user_id, 0)
            )
    return result


async def _load_reward_context(
    db: AsyncSession,
    sessions: list[MealSession],
) -> tuple[dict[UUID, Reward], dict[UUID, Decimal], dict[UUID, Decimal]]:
    """Fetch every reward + final-score + threshold row keyed by session id.

    Batched so the orders-list endpoints don't fan out one query per row.
    Returns (rewards_by_session, final_score_by_session, threshold_by_session).
    threshold is taken from the reward rule that applied to the session's
    validation (defaulted from the restaurant's currently-active rule for
    sessions that were rejected before any rule lookup).
    """
    session_ids = [s.id for s in sessions]
    if not session_ids:
        return {}, {}, {}

    rewards_res = await db.execute(
        select(Reward).where(Reward.meal_session_id.in_(session_ids))
    )
    rewards_by_session: dict[UUID, Reward] = {
        r.meal_session_id: r for r in rewards_res.scalars().all()
    }

    validation_res = await db.execute(
        select(StaffValidation.meal_session_id, StaffValidation.final_score).where(
            StaffValidation.meal_session_id.in_(session_ids)
        )
    )
    final_score_by_session: dict[UUID, Decimal] = {
        sid: score for sid, score in validation_res.all()
    }

    restaurant_ids = {s.restaurant_id for s in sessions}
    rule_res = await db.execute(
        select(RewardRule).where(
            RewardRule.restaurant_id.in_(restaurant_ids),
            RewardRule.is_active.is_(True),
        )
    )
    threshold_by_restaurant: dict[UUID, Decimal] = {}
    for rule in rule_res.scalars().all():
        threshold_by_restaurant.setdefault(rule.restaurant_id, rule.consumption_threshold)
    threshold_by_session: dict[UUID, Decimal] = {}
    for s in sessions:
        threshold = threshold_by_restaurant.get(s.restaurant_id)
        if threshold is not None:
            threshold_by_session[s.id] = threshold
    return rewards_by_session, final_score_by_session, threshold_by_session


def _reward_and_outcome_for_session(
    session: MealSession,
    reward: Reward | None,
    final_score: Decimal | None,
    threshold: Decimal | None,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Compute the (reward, reward_outcome) pair for a single session.

    Both fields are null when the session isn't in a terminal
    reward-decision state — the drawer skips the section entirely in
    that case. Walk-in sessions in a terminal state always land on the
    `walkin_not_eligible` outcome, since the reward pipeline only runs
    for QR sessions.
    """
    if session.status not in _TERMINAL_REWARD_DECISION_STATUSES:
        return None, None

    if reward is not None:
        status = "issued"
        if reward.voided_at is not None:
            status = "voided"
        elif reward.redeemed_at is not None:
            status = "redeemed"
        # Privacy: staff must not see raw codes while the reward is still
        # active — otherwise they could redeem it themselves without the
        # diner presenting it. Codes for redeemed/voided rows are past
        # events and safe to expose for the audit trail.
        visible_code = (
            reward.redemption_code if status in ("redeemed", "voided") else None
        )
        return (
            {
                "id": str(reward.id),
                "redemption_code": visible_code,
                "value_minor": int(reward.value_minor),
                "status": status,
                "issued_at": reward.issued_at.isoformat(),
                "redeemed_at": (
                    reward.redeemed_at.isoformat() if reward.redeemed_at else None
                ),
                "voided_at": (
                    reward.voided_at.isoformat() if reward.voided_at else None
                ),
                "voided_reason": reward.voided_reason,
            },
            None,
        )

    if session.entry_channel == "walkin":
        return None, {"reason": "walkin_not_eligible"}

    if session.status == "staff_rejected":
        return None, {"reason": "rejected"}

    if final_score is not None and threshold is not None:
        return None, {
            "reason": "below_threshold",
            "score": float(final_score),
            "threshold": float(threshold),
        }

    # Terminal but no reward, no validation, no rule — degenerate case
    # (e.g. session expired before any decision). Skip the section.
    return None, None


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

    rewards_by_session, final_score_by_session, threshold_by_session = (
        await _load_reward_context(db, sessions)
    )
    loyalty_by_session = await _load_loyalty_scores(db, sessions)

    now = datetime.now(UTC)
    out: list[dict[str, Any]] = []
    for s in sessions:
        items = items_by_session.get(s.id, [])
        # `open` sessions without items don't belong on the board — the
        # diner hasn't chosen anything yet.
        if s.status == "open" and not items:
            continue
        bill = bills_by_session.get(s.id)
        reward_dict, outcome_dict = _reward_and_outcome_for_session(
            s,
            rewards_by_session.get(s.id),
            final_score_by_session.get(s.id),
            threshold_by_session.get(s.id),
        )
        out.append(
            {
                "session_id": str(s.id),
                "table_code": s.table_code,
                "status": s.status,
                "entry_channel": s.entry_channel,
                "is_takeaway": s.is_takeaway,
                "customer_email": s.customer_email,
                "customer_phone": s.customer_phone,
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
                "reward": reward_dict,
                "reward_outcome": outcome_dict,
                "loyalty_score": loyalty_by_session.get(s.id),
            }
        )
    return {"orders": out}


# Statuses that qualify a session as "done" — the money is either
# settled (rewarded / staff_approved / staff_rejected), the diner
# walked away (expired), the order got pulled (cancelled), or a
# dispute is on record. Everything the diner can't act on anymore
# lives here.
_PAST_ORDER_STATUSES = (
    "staff_approved",
    "staff_rejected",
    "rewarded",
    "expired",
    "disputed",
    "cancelled",
    # Walk-in terminal states (migration 0016).
    "voided",
    "paid",
)


@router.get("/restaurants/{restaurant_id}/dashboard/badges")
async def dashboard_badges(
    restaurant_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    """Lightweight counters for the sidebar nav badges. Returned in
    one round-trip so the frontend can poll the whole dashboard
    signal in a single request every ~15s without spamming the
    heavier per-view endpoints (kanban orders, validation queue,
    disputes list — all of which do joins and item hydration).

    Values reflect the ACTIONABLE queue length for each surface,
    not lifetime totals:
      • `orders_active` — sessions the kitchen or floor still owes
        work on (open → before_captured → eating → after_submitted).
        Anything in `pending_staff_validation` moves to the
        validations counter instead.
      • `validations_pending` — the review queue on the staff
        dashboard's Validations screen.
      • `disputes_open` — open disputes only. Resolved ones drop off
        the counter but stay visible in the "All" filter.
    """
    await _ensure_staff(db, user, restaurant_id)
    if (await db.get(Restaurant, restaurant_id)) is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    orders_active = await db.scalar(
        select(func.count(MealSession.id)).where(
            MealSession.restaurant_id == restaurant_id,
            MealSession.status.in_(
                (
                    "open",
                    "before_captured",
                    "eating",
                    "after_submitted",
                )
            ),
        )
    )
    validations_pending = await db.scalar(
        select(func.count(MealSession.id)).where(
            MealSession.restaurant_id == restaurant_id,
            MealSession.status == "pending_staff_validation",
        )
    )
    disputes_open = await db.scalar(
        select(func.count(Dispute.id))
        .join(MealSession, MealSession.id == Dispute.meal_session_id)
        .where(
            MealSession.restaurant_id == restaurant_id,
            Dispute.status == "open",
        )
    )
    # `rewards_issued_today` is monotonic across the day, so a
    # positive delta between two poll cycles means "a new reward
    # just landed for a diner." That's the signal the frontend
    # uses to fire the "claim done" toast — no separate event
    # bus needed at pilot scale.
    today_start = datetime.now(UTC).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    rewards_issued_today = await db.scalar(
        select(func.count(Reward.id))
        .join(MealSession, MealSession.id == Reward.meal_session_id)
        .where(
            MealSession.restaurant_id == restaurant_id,
            Reward.issued_at >= today_start,
        )
    )
    return {
        "orders_active": int(orders_active or 0),
        "validations_pending": int(validations_pending or 0),
        "disputes_open": int(disputes_open or 0),
        "rewards_issued_today": int(rewards_issued_today or 0),
    }


@router.get("/restaurants/{restaurant_id}/dashboard/orders/past")
async def list_past_orders(
    restaurant_id: UUID,
    limit: int = Query(default=50, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Past orders board — everything that's dropped off the live view.

    Same row shape as `/dashboard/orders` (so the frontend can share
    the OrderCard render) plus a `cancelled_reason` field for the
    session-detail modal on the past-orders screen.

    Ordered by `started_at DESC` — the freshest completed order lands
    at the top. Bounded by `limit` (default 50) so a busy restaurant
    doesn't page in months of history on first load; the frontend
    can offer a "load more" later if it matters.
    """
    await _ensure_staff(db, user, restaurant_id)
    if (await db.get(Restaurant, restaurant_id)) is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    sess_res = await db.execute(
        select(MealSession)
        .where(
            MealSession.restaurant_id == restaurant_id,
            MealSession.status.in_(_PAST_ORDER_STATUSES),
        )
        .order_by(MealSession.started_at.desc())
        .limit(limit)
    )
    sessions = list(sess_res.scalars().all())
    if not sessions:
        return {"orders": []}

    session_ids = [s.id for s in sessions]

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

    bills_res = await db.execute(
        select(Bill).where(Bill.meal_session_id.in_(session_ids))
    )
    bills_by_session: dict[UUID, Bill] = {
        b.meal_session_id: b for b in bills_res.scalars().all()
    }

    rewards_by_session, final_score_by_session, threshold_by_session = (
        await _load_reward_context(db, sessions)
    )

    now = datetime.now(UTC)
    out: list[dict[str, Any]] = []
    for s in sessions:
        bill = bills_by_session.get(s.id)
        reward_dict, outcome_dict = _reward_and_outcome_for_session(
            s,
            rewards_by_session.get(s.id),
            final_score_by_session.get(s.id),
            threshold_by_session.get(s.id),
        )
        out.append(
            {
                "session_id": str(s.id),
                "table_code": s.table_code,
                "status": s.status,
                "is_takeaway": s.is_takeaway,
                "items": items_by_session.get(s.id, []),
                "started_at": s.started_at.isoformat(),
                "started_seconds_ago": int((now - s.started_at).total_seconds()),
                "kitchen_ack_at": (
                    s.kitchen_ack_at.isoformat() if s.kitchen_ack_at else None
                ),
                # Only the past-orders shape carries this — the diner
                # sees it on SessionStatus (ethics rule 9), and the
                # staff sees it on the past-orders card so they can
                # audit their own decision later.
                "cancelled_reason": s.cancelled_reason,
                "cancelled_at": (
                    s.cancelled_at.isoformat() if s.cancelled_at else None
                ),
                "bill_id": str(bill.id) if bill else None,
                "bill_number": bill.bill_number if bill else None,
                "bill_delivery_status": bill.delivery_status if bill else None,
                "bill_total_minor": bill.total_minor if bill else None,
                "bill_sent_at": (
                    bill.sent_at.isoformat() if bill and bill.sent_at else None
                ),
                "bill_delivery_email": bill.delivery_email if bill else None,
                "bill_delivery_phone": bill.delivery_phone if bill else None,
                "reward": reward_dict,
                "reward_outcome": outcome_dict,
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


@router.get("/restaurants/{restaurant_id}/dashboard/rewards-summary")
async def rewards_summary(
    restaurant_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Reward-count + value totals for three fixed windows (today,
    last 7 days, last 30 days) plus a 14-day daily-count sparkline
    for the Rewards analytics screen's stat cards.

    Only counts rewards issued (Reward rows) — voided rewards are
    included since staff want to see the throughput signal that led
    to a voided code. The `value_minor` totals sum
    `rewards.value_minor` (issuance-time value), NOT
    `redeemed_value_minor`, so the number matches what was originally
    granted regardless of half-value expiry.
    """
    await _ensure_staff(db, user, restaurant_id)
    if (await db.get(Restaurant, restaurant_id)) is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    now = datetime.now(UTC)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=6)  # today + 6 prior = 7 days
    month_start = today_start - timedelta(days=29)  # today + 29 prior = 30 days
    sparkline_start = today_start - timedelta(days=13)  # 14 days incl. today

    async def _window_totals(since: datetime) -> tuple[int, int]:
        row = (
            await db.execute(
                select(
                    func.count(Reward.id),
                    func.coalesce(func.sum(Reward.value_minor), 0),
                )
                .join(MealSession, MealSession.id == Reward.meal_session_id)
                .where(
                    MealSession.restaurant_id == restaurant_id,
                    Reward.issued_at >= since,
                )
            )
        ).one()
        count, total = row
        return int(count or 0), int(total or 0)

    today_count, today_value = await _window_totals(today_start)
    week_count, week_value = await _window_totals(week_start)
    month_count, month_value = await _window_totals(month_start)

    # 14-day daily-count sparkline. One query, bucketed in Python so
    # the same code works on postgres and sqlite (used in the pytest
    # suite). Same array is returned for all three cards — the task's
    # response shape carries it per-card, but a single 14-day window
    # is what the design shows.
    sparkline_rows = await db.execute(
        select(Reward.issued_at)
        .join(MealSession, MealSession.id == Reward.meal_session_id)
        .where(
            MealSession.restaurant_id == restaurant_id,
            Reward.issued_at >= sparkline_start,
        )
    )
    buckets = [0] * 14
    for (issued_at,) in sparkline_rows.all():
        # Guard against naive datetimes coming back from sqlite — the
        # column is TIMESTAMPTZ in postgres but sqlite drops tzinfo,
        # so re-attach UTC before doing arithmetic against `now`.
        if issued_at.tzinfo is None:
            issued_at = issued_at.replace(tzinfo=UTC)
        idx = 13 - (today_start - issued_at.replace(
            hour=0, minute=0, second=0, microsecond=0
        )).days
        if 0 <= idx < 14:
            buckets[idx] += 1

    card = lambda count, value: {  # noqa: E731
        "count": count,
        "value_minor": value,
        "sparkline": buckets,
    }
    return {
        "today": card(today_count, today_value),
        "week": card(week_count, week_value),
        "month": card(month_count, month_value),
    }


@router.get("/restaurants/{restaurant_id}/dashboard/rewards-list")
async def rewards_list(
    restaurant_id: UUID,
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = Query(default=None),
    status_filter: Literal["issued", "redeemed", "voided", "all"] = Query(
        default="all", alias="status"
    ),
    limit: int = Query(default=50, ge=1, le=200),
    cursor: datetime | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Paginated rewards list for the Rewards analytics table.

    Rows are sorted by `issued_at DESC`. `cursor` is the `issued_at` of
    the last row of the previous page (exclusive); pass it verbatim to
    load the next page. `next_cursor` is null when there are no more
    rows.

    `status` semantics:
      • `issued` — active, not redeemed, not voided
      • `redeemed` — has a redeemed_at
      • `voided` — has a voided_at
      • `all` — no status filter
    """
    await _ensure_staff(db, user, restaurant_id)
    if (await db.get(Restaurant, restaurant_id)) is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    q = (
        select(Reward, MealSession.table_code)
        .join(MealSession, MealSession.id == Reward.meal_session_id)
        .where(MealSession.restaurant_id == restaurant_id)
    )
    if from_ is not None:
        q = q.where(Reward.issued_at >= from_)
    if to is not None:
        q = q.where(Reward.issued_at < to)
    if status_filter == "issued":
        q = q.where(Reward.redeemed_at.is_(None), Reward.voided_at.is_(None))
    elif status_filter == "redeemed":
        q = q.where(Reward.redeemed_at.is_not(None))
    elif status_filter == "voided":
        q = q.where(Reward.voided_at.is_not(None))
    if cursor is not None:
        q = q.where(Reward.issued_at < cursor)

    q = q.order_by(Reward.issued_at.desc()).limit(limit + 1)
    rows = list((await db.execute(q)).all())

    has_more = len(rows) > limit
    rows = rows[:limit]

    def _row(reward: Reward, table_code: str) -> dict[str, Any]:
        if reward.voided_at is not None:
            status = "voided"
        elif reward.redeemed_at is not None:
            status = "redeemed"
        else:
            status = "issued"
        # Same privacy gate as the session-detail helper — a still-issued
        # code is the diner's; only surface it after redeem/void so it's
        # an audit-trail read, not a shortcut to silent redemption.
        visible_code = (
            reward.redemption_code if status in ("redeemed", "voided") else None
        )
        return {
            "id": str(reward.id),
            "redemption_code": visible_code,
            "table_code": table_code,
            "value_minor": int(reward.value_minor),
            "status": status,
            "issued_at": reward.issued_at.isoformat(),
            "redeemed_at": (
                reward.redeemed_at.isoformat() if reward.redeemed_at else None
            ),
            "voided_at": (
                reward.voided_at.isoformat() if reward.voided_at else None
            ),
        }

    out_rows = [_row(reward, table_code) for reward, table_code in rows]
    next_cursor = rows[-1][0].issued_at.isoformat() if has_more and rows else None
    return {"rows": out_rows, "next_cursor": next_cursor}


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
    """Record a resolution + notes. Idempotent: re-applying the same
    status keeps the original resolver / resolution_notes; a
    conflicting status returns 409 so the audit trail stays clean.

    Auth: any staff of the restaurant, unless they were the staff who
    made the original call on the disputed session — see
    `_ensure_can_resolve_dispute` for the ethics-rule-8 rationale.
    """
    dispute = await db.get(Dispute, dispute_id)
    if dispute is None:
        raise HTTPException(status_code=404, detail="Dispute not found")
    session = await db.get(MealSession, dispute.meal_session_id)
    if session is None or session.restaurant_id != restaurant_id:
        raise HTTPException(status_code=404, detail="Dispute not found")
    # Auth check runs after the dispute + session lookups so a
    # not-on-staff caller still gets 403 (never 404), and 404 (not
    # 403) for a genuinely missing dispute even to legitimate staff.
    await _ensure_can_resolve_dispute(db, user, restaurant_id)

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

    now = datetime.now(UTC)
    dispute.status = payload.status
    dispute.resolved_by_user_id = user.id
    dispute.resolved_at = now
    if payload.resolution_notes is not None:
        dispute.resolution_notes = payload.resolution_notes

    # Compensation reward — when the owner sides with the diner, mint
    # a make-good coupon so the diner isn't left with just an apology.
    # Reuses the restaurant's active RewardRule (same shape and value
    # as a normal reward), tied to the disputed session so the code's
    # provenance is auditable. Idempotency: if this session already
    # has a non-voided reward we skip — no double-issue on a repeat
    # resolve or a dispute over a session that was actually rewarded.
    compensation_reward: Reward | None = None
    if payload.status == "resolved_in_favor_diner":
        existing_reward = await db.scalar(
            select(Reward).where(
                Reward.meal_session_id == session.id,
                Reward.voided_at.is_(None),
            )
        )
        if existing_reward is None:
            rule = await db.scalar(
                select(RewardRule).where(
                    RewardRule.restaurant_id == session.restaurant_id,
                    RewardRule.is_active.is_(True),
                )
            )
            if rule is not None:
                reward_item = await db.get(MenuItem, rule.reward_menu_item_id)
                menu_value = (
                    rule.reward_value_minor
                    if rule.reward_value_minor is not None
                    else (reward_item.price_minor if reward_item is not None else 0)
                )
                settings = get_settings()
                half_value_at = now + timedelta(
                    days=settings.REWARD_FULL_VALUE_DAYS
                )
                expires_at = now + timedelta(days=settings.REWARD_EXPIRY_DAYS)
                compensation_reward = Reward(
                    meal_session_id=session.id,
                    reward_rule_id=rule.id,
                    redemption_code=new_redemption_code(),
                    reward_type="menu_item",
                    value_minor=menu_value,
                    issued_at=now,
                    half_value_at=half_value_at,
                    expires_at=expires_at,
                )
                db.add(compensation_reward)

    await db.commit()
    await db.refresh(dispute)
    if compensation_reward is not None:
        await db.refresh(compensation_reward)
    return {
        "id": str(dispute.id),
        "status": dispute.status,
        "resolution_notes": dispute.resolution_notes,
        "resolved_at": dispute.resolved_at.isoformat() if dispute.resolved_at else None,
        "compensation_reward": (
            {
                "id": str(compensation_reward.id),
                "redemption_code": compensation_reward.redemption_code,
                "value_minor": compensation_reward.value_minor,
                "expires_at": compensation_reward.expires_at.isoformat(),
            }
            if compensation_reward is not None
            else None
        ),
    }


# ── Analytics overview screen ───────────────────────────────────────────
#
# Powers the /analytics screen's five widgets in one round-trip:
# revenue trend, peak-hours heatmap, top items, avg ticket, and the
# new-vs-repeat diner ratio. Sales + traffic only — inventory tracking
# is explicitly out of scope for this surface.


_ANALYTICS_RANGE_LABELS = {
    "7d": "Last 7 days",
    "30d": "Last 30 days",
    "this_month": "This month",
    "last_month": "Last month",
    "custom": "Custom range",
}


def _tz_for_restaurant(restaurant: Restaurant) -> ZoneInfo:
    """Same fallback as bills_dashboard — a corrupt IANA string on the
    restaurant row shouldn't 500 the analytics call."""
    try:
        return ZoneInfo(restaurant.timezone or "UTC")
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _analytics_range_bounds(
    range_key: str,
    tz: ZoneInfo,
    custom_from: datetime | None,
    custom_to: datetime | None,
    now_utc: datetime,
) -> tuple[datetime, datetime, str]:
    """Return (from_utc, to_utc, label). All bounds are UTC datetimes;
    the label is the human string shown on the screen.

    `7d` / `30d` are rolling — from = now - N days. `this_month` and
    `last_month` are calendar months in the restaurant's local
    timezone (so a Kolkata restaurant's "this month" doesn't start
    at 05:30 IST because UTC midnight lands there). `custom` requires
    both bounds; a missing bound → 400.
    """
    label = _ANALYTICS_RANGE_LABELS[range_key]
    if range_key == "7d":
        return now_utc - timedelta(days=7), now_utc, label
    if range_key == "30d":
        return now_utc - timedelta(days=30), now_utc, label
    if range_key == "this_month":
        local_now = now_utc.astimezone(tz)
        start_local = datetime(
            local_now.year, local_now.month, 1, 0, 0, 0, tzinfo=tz
        )
        return start_local.astimezone(UTC), now_utc, label
    if range_key == "last_month":
        local_now = now_utc.astimezone(tz)
        year = local_now.year
        month = local_now.month - 1
        if month == 0:
            month = 12
            year -= 1
        start_local = datetime(year, month, 1, 0, 0, 0, tzinfo=tz)
        _, last_day = monthrange(year, month)
        end_local = datetime(
            year, month, last_day, 23, 59, 59, 999_999, tzinfo=tz
        ) + timedelta(microseconds=1)
        return start_local.astimezone(UTC), end_local.astimezone(UTC), label
    if range_key == "custom":
        if custom_from is None or custom_to is None:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "INVALID_RANGE",
                    "message": "custom range requires both from and to.",
                },
            )
        # Normalise naive datetimes to UTC — sqlite / URL parsing
        # sometimes hands us tz-naive values from the query string.
        f = custom_from if custom_from.tzinfo else custom_from.replace(tzinfo=UTC)
        t = custom_to if custom_to.tzinfo else custom_to.replace(tzinfo=UTC)
        if f >= t:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "INVALID_RANGE",
                    "message": "from must be strictly before to.",
                },
            )
        return f, t, label
    # Should be unreachable — Query pattern already restricts values.
    raise HTTPException(status_code=400, detail={"code": "INVALID_RANGE"})


def _as_utc(dt: datetime) -> datetime:
    """SQLite drops tzinfo from TIMESTAMPTZ round-trips; postgres keeps
    it. Normalise to aware-UTC so downstream arithmetic + isoformat is
    consistent between prod and pytest."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


@router.get("/restaurants/{restaurant_id}/dashboard/analytics-overview")
async def analytics_overview(
    restaurant_id: UUID,
    # Alias keeps the URL query name `range` (matches the client) while
    # the Python parameter avoids shadowing the built-in.
    range_key: str = Query(
        default="30d",
        alias="range",
        pattern="^(7d|30d|this_month|last_month|custom)$",
    ),
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Restaurant analytics screen aggregations — one round-trip for the
    five widgets the /analytics screen renders.

    All numbers scoped to `restaurant_id`. Time-bucketing runs in the
    restaurant's local timezone so a "daily" bar on the revenue chart
    lines up with a Kolkata restaurant's calendar day, not UTC's.

    Explicitly NOT cached, not materialised — pilot scale is fine with
    fresh queries. Revisit if a restaurant crosses ~10k sessions/month.
    """
    await _ensure_staff(db, user, restaurant_id)
    restaurant = await db.get(Restaurant, restaurant_id)
    if restaurant is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    tz = _tz_for_restaurant(restaurant)
    now_utc = datetime.now(UTC)
    from_utc, to_utc, label = _analytics_range_bounds(
        range_key, tz, from_, to, now_utc
    )
    window_seconds = (to_utc - from_utc).total_seconds()
    prior_from_utc = from_utc - timedelta(seconds=window_seconds)
    prior_to_utc = from_utc

    # ── Revenue: bills in the window, non-voided sessions ────────────
    # We treat a bill as revenue whenever its parent session isn't
    # voided. In phase 1 QR sessions never enter paid/voided so their
    # bills always count; walk-ins that were voided at the counter drop
    # out on the voided_at IS NOT NULL check.
    revenue_rows = (
        await db.execute(
            select(Bill.total_minor, Bill.created_at)
            .join(MealSession, MealSession.id == Bill.meal_session_id)
            .where(
                Bill.restaurant_id == restaurant_id,
                Bill.created_at >= from_utc,
                Bill.created_at < to_utc,
                MealSession.voided_at.is_(None),
            )
        )
    ).all()
    total_minor = 0
    daily_totals: dict[str, int] = {}
    for total, created_at in revenue_rows:
        total_int = int(total)
        total_minor += total_int
        local_day = _as_utc(created_at).astimezone(tz).strftime("%Y-%m-%d")
        daily_totals[local_day] = daily_totals.get(local_day, 0) + total_int

    # Prior-window revenue total for the delta pill. Same non-voided
    # filter so the comparison is apples-to-apples.
    prior_revenue_total = int(
        await db.scalar(
            select(func.coalesce(func.sum(Bill.total_minor), 0))
            .join(MealSession, MealSession.id == Bill.meal_session_id)
            .where(
                Bill.restaurant_id == restaurant_id,
                Bill.created_at >= prior_from_utc,
                Bill.created_at < prior_to_utc,
                MealSession.voided_at.is_(None),
            )
        )
        or 0
    )

    # Fill every local day in the range so the chart doesn't skip empty
    # days — the frontend expects a dense series.
    daily: list[dict[str, Any]] = []
    cursor_local = from_utc.astimezone(tz).date()
    end_local = to_utc.astimezone(tz).date()
    days_in_range = 0
    while cursor_local <= end_local:
        key = cursor_local.strftime("%Y-%m-%d")
        daily.append({"date": key, "total_minor": daily_totals.get(key, 0)})
        cursor_local = cursor_local + timedelta(days=1)
        days_in_range += 1
    avg_per_day_minor = total_minor // days_in_range if days_in_range else 0

    def _delta_pct(current: int, prior: int) -> float | None:
        if prior == 0:
            return None
        return round((current - prior) / prior * 100, 2)

    revenue_delta_pct = _delta_pct(total_minor, prior_revenue_total)

    # ── Peak hours: 7×24 grid of session start counts, dow=Mon..Sun ──
    # dow follows ISO / Python weekday() where Monday=0..Sunday=6 so it
    # matches the frontend heatmap's Mon-first row order.
    peak_rows = (
        await db.execute(
            select(MealSession.started_at).where(
                MealSession.restaurant_id == restaurant_id,
                MealSession.started_at >= from_utc,
                MealSession.started_at < to_utc,
            )
        )
    ).all()
    peak_grid: dict[tuple[int, int], int] = {}
    for (started_at,) in peak_rows:
        local = _as_utc(started_at).astimezone(tz)
        key = (local.weekday(), local.hour)
        peak_grid[key] = peak_grid.get(key, 0) + 1
    peak_buckets = [
        {"dow": dow, "hour": hour, "session_count": peak_grid.get((dow, hour), 0)}
        for dow in range(7)
        for hour in range(24)
    ]

    # ── Top items: joined via meal_session_items × menu_items × bills ─
    # Filter is bill in-range + session not voided. Sums quantity and
    # (quantity × price) so a party of four ordering two mains counts
    # as 8 units of that dish, not one row.
    top_item_rows = (
        await db.execute(
            select(
                MenuItem.id,
                MenuItem.name,
                func.sum(MealSessionItem.quantity).label("count"),
                func.sum(
                    MealSessionItem.quantity * MenuItem.price_minor
                ).label("revenue_minor"),
            )
            .join(
                MealSessionItem,
                MealSessionItem.menu_item_id == MenuItem.id,
            )
            .join(
                MealSession,
                MealSession.id == MealSessionItem.meal_session_id,
            )
            .join(Bill, Bill.meal_session_id == MealSession.id)
            .where(
                Bill.restaurant_id == restaurant_id,
                Bill.created_at >= from_utc,
                Bill.created_at < to_utc,
                MealSession.voided_at.is_(None),
            )
            .group_by(MenuItem.id, MenuItem.name)
            .order_by(func.sum(MealSessionItem.quantity).desc())
            .limit(10)
        )
    ).all()
    top_items = [
        {
            "menu_item_id": str(row.id),
            "name": row.name,
            "count": int(row.count),
            "revenue_minor": int(row.revenue_minor),
        }
        for row in top_item_rows
    ]

    # ── Avg ticket: mean of bill.total_minor for non-voided bills ────
    async def _avg_ticket(win_from: datetime, win_to: datetime) -> int:
        row = (
            await db.execute(
                select(
                    func.coalesce(func.avg(Bill.total_minor), 0)
                )
                .join(MealSession, MealSession.id == Bill.meal_session_id)
                .where(
                    Bill.restaurant_id == restaurant_id,
                    Bill.created_at >= win_from,
                    Bill.created_at < win_to,
                    MealSession.voided_at.is_(None),
                )
            )
        ).one()
        return int(row[0] or 0)

    avg_ticket_current = await _avg_ticket(from_utc, to_utc)
    avg_ticket_prior = await _avg_ticket(prior_from_utc, prior_to_utc)
    avg_ticket_delta = _delta_pct(avg_ticket_current, avg_ticket_prior)

    # ── Diner ratio: new vs repeat vs anonymous ──────────────────────
    # A diner counts once per range. "New" if their earliest session at
    # this restaurant (any status) lands in the range; "repeat" if the
    # earliest sits before the range start. Sessions without a
    # diner_user_id are anonymous / walk-in.
    in_range_diner_rows = (
        await db.execute(
            select(MealSession.diner_user_id).where(
                MealSession.restaurant_id == restaurant_id,
                MealSession.started_at >= from_utc,
                MealSession.started_at < to_utc,
            )
        )
    ).all()
    anonymous_count = 0
    diner_ids: set[UUID] = set()
    for (diner_id,) in in_range_diner_rows:
        if diner_id is None:
            anonymous_count += 1
        else:
            diner_ids.add(diner_id)

    new_count = 0
    repeat_count = 0
    if diner_ids:
        earliest_rows = (
            await db.execute(
                select(
                    MealSession.diner_user_id,
                    func.min(MealSession.started_at).label("earliest"),
                )
                .where(
                    MealSession.restaurant_id == restaurant_id,
                    MealSession.diner_user_id.in_(diner_ids),
                )
                .group_by(MealSession.diner_user_id)
            )
        ).all()
        for _diner_id, earliest in earliest_rows:
            earliest_utc = _as_utc(earliest)
            if earliest_utc >= from_utc:
                new_count += 1
            else:
                repeat_count += 1

    return {
        "range": {
            "from": from_utc.isoformat(),
            "to": to_utc.isoformat(),
            "label": label,
        },
        "revenue": {
            "total_minor": total_minor,
            "avg_per_day_minor": avg_per_day_minor,
            "prior_period_total_minor": prior_revenue_total,
            "delta_pct": revenue_delta_pct,
            "daily": daily,
        },
        "peak_hours": {"buckets": peak_buckets},
        "top_items": top_items,
        "avg_ticket": {
            "minor": avg_ticket_current,
            "prior_period_minor": avg_ticket_prior,
            "delta_pct": avg_ticket_delta,
        },
        "diner_ratio": {
            "new_count": new_count,
            "repeat_count": repeat_count,
            "anonymous_count": anonymous_count,
        },
    }
