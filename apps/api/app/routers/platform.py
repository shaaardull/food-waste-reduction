"""Platform-owner analytics + bug-report triage.

Two mounts on this router:

1. Staff-facing at `/bug-reports` — any restaurant staff can POST a
   report. Read-only listing by ID is scoped to the reporter's own
   restaurants for privacy (staff at Konkan Kitchen doesn't need to
   see Spice Trail's bug queue).

2. Admin-only at `/admin/platform/*` — the platform-owner backdoor.
   Every endpoint here checks `user.role == 'admin'` and returns 404
   (not 403) to unauthorised callers so the URL surface stays
   "hidden" — a stray curl by a staff who guessed the path can't
   even confirm the endpoint exists.

Metrics ethos: aggregate scalars + a per-restaurant leaderboard, all
computed against the same time window the caller picked. No per-diner
leaderboard (PII / minor-protection), no per-staff column beyond
what's already surfaced on the existing staff-metrics dashboard.

Range values are the same short shorthand used elsewhere on the
public stats page: 7d / 30d / 90d / all.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.bill import Bill
from app.models.bug_report import BugReport
from app.models.dispute import Dispute
from app.models.fraud_signal import FraudSignal
from app.models.meal_session import MealSession, MealSessionItem
from app.models.menu_item import MenuItem
from app.models.restaurant import Restaurant, RestaurantStaff
from app.models.reward import Reward
from app.models.staff_validation import StaffValidation
from app.models.user import User
from app.schemas.bug_report import (
    BugReportCreateIn,
    BugReportOut,
    BugReportPatchIn,
    BugStatus,
)
from app.security import get_current_user
from app.services import sustainability as sustainability_svc

router = APIRouter()


# ────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────

# Same short-code range set as /public/stats. `all` maps to a very
# wide window so we don't need a separate branch — 10 years easily
# covers any plausible operating history.
_ALL_TIME_DAYS = 365 * 10
_RANGES = {"7d": 7, "30d": 30, "90d": 90, "all": _ALL_TIME_DAYS}


def _require_admin(user: User) -> None:
    """Backdoor auth. Non-admin callers get 404 (not 403) so the URL
    doesn't confirm the endpoint exists to a staff-role user who
    guessed the path — the platform-owner surface is meant to be
    genuinely hidden."""
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


def _since_for(range_code: str) -> datetime:
    return datetime.now(UTC) - timedelta(days=_RANGES[range_code])


async def _staff_restaurant_ids(
    db: AsyncSession, user: User
) -> list[UUID]:
    """Return the restaurants this staff belongs to. Empty list for
    admin / diner (admin has no restaurant scope; diner has no staff
    membership by definition)."""
    if user.role != "staff":
        return []
    res = await db.execute(
        select(RestaurantStaff.restaurant_id).where(
            RestaurantStaff.user_id == user.id,
        )
    )
    return [row[0] for row in res.all()]


def _bug_row_to_out(
    bug: BugReport,
    *,
    reporter: User | None = None,
    restaurant: Restaurant | None = None,
) -> BugReportOut:
    return BugReportOut(
        id=bug.id,
        restaurant_id=bug.restaurant_id,
        restaurant_name=restaurant.name if restaurant is not None else None,
        reported_by_user_id=bug.reported_by_user_id,
        reported_by_email=reporter.email if reporter is not None else None,
        reported_by_display_name=(
            reporter.display_name if reporter is not None else None
        ),
        title=bug.title,
        description=bug.description,
        severity=bug.severity,  # type: ignore[arg-type]
        status=bug.status,  # type: ignore[arg-type]
        admin_notes=bug.admin_notes,
        created_at=bug.created_at,
        updated_at=bug.updated_at,
    )


# ────────────────────────────────────────────────────────────────
# Staff-facing: file a bug
# ────────────────────────────────────────────────────────────────


@router.post(
    "/bug-reports",
    response_model=BugReportOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_bug_report(
    payload: BugReportCreateIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BugReportOut:
    """Any signed-in staff (or admin) files a bug report.

    Restaurant binding:
    - If the payload carries `restaurant_id`, we verify the staff is
      on that restaurant's team (or admin) before attaching.
    - If not, we auto-attach the staff's FIRST restaurant membership.
      Most restaurants have one staff-per-team; the edge case of a
      staff shared across two restaurants gets whichever they were
      onboarded on first, and they can edit later via /patch.
    - Admin-role users may file without a restaurant (platform bug).
    """
    restaurant_id = payload.restaurant_id
    if restaurant_id is not None:
        # Verify staff owns this restaurant scope.
        if user.role != "admin":
            memberships = await _staff_restaurant_ids(db, user)
            if restaurant_id not in memberships:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="You are not on the staff of that restaurant",
                )
    elif user.role == "staff":
        # Auto-attach first membership.
        memberships = await _staff_restaurant_ids(db, user)
        restaurant_id = memberships[0] if memberships else None

    bug = BugReport(
        restaurant_id=restaurant_id,
        reported_by_user_id=user.id,
        title=payload.title.strip(),
        description=payload.description.strip(),
        severity=payload.severity,
        status="open",
    )
    db.add(bug)
    await db.commit()
    await db.refresh(bug)

    restaurant = (
        await db.get(Restaurant, restaurant_id) if restaurant_id else None
    )
    return _bug_row_to_out(bug, reporter=user, restaurant=restaurant)


@router.get("/bug-reports/mine", response_model=list[BugReportOut])
async def list_my_bug_reports(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[BugReportOut]:
    """Staff can see the reports they themselves filed — useful for
    the "any updates?" check-back on the staff dashboard."""
    res = await db.execute(
        select(BugReport)
        .where(BugReport.reported_by_user_id == user.id)
        .order_by(BugReport.created_at.desc())
        .limit(200)
    )
    rows = list(res.scalars().all())
    if not rows:
        return []
    # Batch-load reporter + restaurant.
    restaurant_ids = {b.restaurant_id for b in rows if b.restaurant_id}
    restaurants: dict[UUID, Restaurant] = {}
    if restaurant_ids:
        rres = await db.execute(
            select(Restaurant).where(Restaurant.id.in_(restaurant_ids))
        )
        restaurants = {r.id: r for r in rres.scalars().all()}
    return [
        _bug_row_to_out(
            b,
            reporter=user,
            restaurant=restaurants.get(b.restaurant_id) if b.restaurant_id else None,
        )
        for b in rows
    ]


# ────────────────────────────────────────────────────────────────
# Admin backdoor: bug triage
# ────────────────────────────────────────────────────────────────


@router.get("/admin/platform/bug-reports", response_model=list[BugReportOut])
async def admin_list_bug_reports(
    status_filter: BugStatus | None = Query(default=None, alias="status"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[BugReportOut]:
    _require_admin(user)
    q = select(BugReport)
    if status_filter is not None:
        q = q.where(BugReport.status == status_filter)
    q = q.order_by(BugReport.created_at.desc()).limit(500)
    rows = list((await db.execute(q)).scalars().all())
    if not rows:
        return []
    # Batch-load reporter users + restaurants.
    reporter_ids = {b.reported_by_user_id for b in rows}
    restaurant_ids = {b.restaurant_id for b in rows if b.restaurant_id}
    reporters: dict[UUID, User] = {}
    if reporter_ids:
        rres = await db.execute(select(User).where(User.id.in_(reporter_ids)))
        reporters = {r.id: r for r in rres.scalars().all()}
    restaurants: dict[UUID, Restaurant] = {}
    if restaurant_ids:
        rres = await db.execute(
            select(Restaurant).where(Restaurant.id.in_(restaurant_ids))
        )
        restaurants = {r.id: r for r in rres.scalars().all()}
    return [
        _bug_row_to_out(
            b,
            reporter=reporters.get(b.reported_by_user_id),
            restaurant=restaurants.get(b.restaurant_id) if b.restaurant_id else None,
        )
        for b in rows
    ]


@router.patch(
    "/admin/platform/bug-reports/{bug_id}", response_model=BugReportOut
)
async def admin_patch_bug_report(
    bug_id: UUID,
    payload: BugReportPatchIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BugReportOut:
    """Admin updates the triage state and/or scratches an internal
    note. Original title/description/severity are immutable — a
    misfiled report can be marked wont_fix but never mutated."""
    _require_admin(user)
    bug = await db.get(BugReport, bug_id)
    if bug is None:
        raise HTTPException(status_code=404, detail="Bug report not found")
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(bug, key, value)
    await db.commit()
    await db.refresh(bug)
    reporter = await db.get(User, bug.reported_by_user_id)
    restaurant = (
        await db.get(Restaurant, bug.restaurant_id) if bug.restaurant_id else None
    )
    return _bug_row_to_out(bug, reporter=reporter, restaurant=restaurant)


# ────────────────────────────────────────────────────────────────
# Admin backdoor: analytics
# ────────────────────────────────────────────────────────────────


@router.get("/admin/platform/analytics")
async def admin_platform_analytics(
    range: str = Query(default="30d", pattern="^(7d|30d|90d|all)$"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Platform-owner summary. Two blocks:

    - `summary` — headline scalars across ALL restaurants in the
      time window: restaurants active, diners active, sessions,
      approvals, kg saved, rewards issued/redeemed, revenue,
      GST collected, disputes, fraud.
    - `restaurants` — per-restaurant leaderboard sorted by session
      count (highest first) so the busiest restaurants surface at
      the top. Each row is enough for the admin card grid; the
      caller drills into `/admin/platform/restaurants/:id/analytics`
      for a fuller view.
    """
    _require_admin(user)
    since = _since_for(range)
    now = datetime.now(UTC)

    # ── SUMMARY block ────────────────────────────────────────────
    restaurants_total = await db.scalar(
        select(func.count(Restaurant.id))
    ) or 0
    diners_total = await db.scalar(
        select(func.count(User.id)).where(
            User.role == "diner", User.deleted_at.is_(None)
        )
    ) or 0
    # "Active" = had an approved-or-adjusted validation in window.
    restaurants_active = await db.scalar(
        select(func.count(distinct(StaffValidation.restaurant_id))).where(
            StaffValidation.decided_at >= since,
            StaffValidation.decision.in_(("approved", "adjusted")),
        )
    ) or 0
    diners_active = await db.scalar(
        select(func.count(distinct(MealSession.diner_user_id))).where(
            MealSession.started_at >= since
        )
    ) or 0

    # Sessions breakdown.
    sessions_total = await db.scalar(
        select(func.count(MealSession.id)).where(
            MealSession.started_at >= since
        )
    ) or 0
    sessions_rewarded = await db.scalar(
        select(func.count(MealSession.id)).where(
            MealSession.started_at >= since,
            MealSession.status == "rewarded",
        )
    ) or 0
    sessions_cancelled = await db.scalar(
        select(func.count(MealSession.id)).where(
            MealSession.started_at >= since,
            MealSession.status == "cancelled",
        )
    ) or 0

    # Validations = staff decisions in window.
    validations_total = await db.scalar(
        select(func.count(StaffValidation.id)).where(
            StaffValidation.decided_at >= since
        )
    ) or 0
    validations_approved = await db.scalar(
        select(func.count(StaffValidation.id)).where(
            StaffValidation.decided_at >= since,
            StaffValidation.decision.in_(("approved", "adjusted")),
        )
    ) or 0

    # Sustainability — reuse the same inputs shape the /public/stats
    # endpoint builds; kg_food_saved is derived from approved
    # validations + item categories.
    sustain_rows = await db.execute(
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
            StaffValidation.decided_at >= since,
            StaffValidation.decision.in_(("approved", "adjusted")),
        )
    )
    by_session: dict[UUID, tuple[Decimal, list[tuple[str | None, int]]]] = {}
    for session_id, final_score, quantity, category in sustain_rows.all():
        score = Decimal(str(final_score))
        if session_id not in by_session:
            by_session[session_id] = (score, [])
        by_session[session_id][1].append((category, int(quantity)))
    sustain_input = [
        sustainability_svc.SessionInput(final_score=score, item_categories=items)
        for score, items in by_session.values()
    ]
    sustain = sustainability_svc.compute(
        sustain_input, period_days=_RANGES[range]
    )

    # Rewards.
    rewards_issued = await db.scalar(
        select(func.count(Reward.id)).where(Reward.issued_at >= since)
    ) or 0
    rewards_redeemed = await db.scalar(
        select(func.count(Reward.id)).where(
            Reward.issued_at >= since, Reward.redeemed_at.is_not(None)
        )
    ) or 0

    # Bills — proxy for revenue + GST collected.
    revenue_paise = await db.scalar(
        select(func.coalesce(func.sum(Bill.total_minor), 0)).where(
            Bill.issued_at >= since
        )
    ) or 0
    gst_paise = await db.scalar(
        select(
            func.coalesce(
                func.sum(Bill.cgst_amount_minor + Bill.sgst_amount_minor),
                0,
            )
        ).where(Bill.issued_at >= since)
    ) or 0
    bills_issued = await db.scalar(
        select(func.count(Bill.id)).where(Bill.issued_at >= since)
    ) or 0

    # Disputes.
    disputes_filed = await db.scalar(
        select(func.count(Dispute.id)).where(Dispute.created_at >= since)
    ) or 0
    disputes_resolved = await db.scalar(
        select(func.count(Dispute.id)).where(
            Dispute.created_at >= since,
            Dispute.status.in_(
                ("resolved_in_favor_diner", "resolved_in_favor_restaurant", "closed")
            ),
        )
    ) or 0

    # Fraud signals.
    fraud_blocked = await db.scalar(
        select(func.count(FraudSignal.id)).where(
            FraudSignal.created_at >= since, FraudSignal.severity == "block"
        )
    ) or 0
    fraud_total = await db.scalar(
        select(func.count(FraudSignal.id)).where(FraudSignal.created_at >= since)
    ) or 0

    # Bug reports — headline count of open reports across the
    # platform. The dedicated /bug-reports listing endpoint carries
    # the full detail.
    bugs_open = await db.scalar(
        select(func.count(BugReport.id)).where(BugReport.status == "open")
    ) or 0
    bugs_critical_open = await db.scalar(
        select(func.count(BugReport.id)).where(
            BugReport.status == "open", BugReport.severity == "critical"
        )
    ) or 0

    summary = {
        "restaurants_total": int(restaurants_total),
        "restaurants_active": int(restaurants_active),
        "diners_total": int(diners_total),
        "diners_active": int(diners_active),
        "sessions_total": int(sessions_total),
        "sessions_rewarded": int(sessions_rewarded),
        "sessions_cancelled": int(sessions_cancelled),
        "validations_total": int(validations_total),
        "validations_approved": int(validations_approved),
        "approval_rate": (
            round(int(validations_approved) / int(validations_total), 4)
            if validations_total
            else None
        ),
        "kg_food_saved": sustain.kg_food_saved,
        "kg_co2e_saved": sustain.kg_co2e_saved,
        "trees_day_equivalent": sustain.trees_day_equivalent,
        "rewards_issued": int(rewards_issued),
        "rewards_redeemed": int(rewards_redeemed),
        "redemption_rate": (
            round(int(rewards_redeemed) / int(rewards_issued), 4)
            if rewards_issued
            else None
        ),
        "bills_issued": int(bills_issued),
        "revenue_paise": int(revenue_paise),
        "gst_paise": int(gst_paise),
        "disputes_filed": int(disputes_filed),
        "disputes_resolved": int(disputes_resolved),
        "fraud_signals_total": int(fraud_total),
        "fraud_signals_blocked": int(fraud_blocked),
        "bugs_open": int(bugs_open),
        "bugs_critical_open": int(bugs_critical_open),
    }

    # ── LEADERBOARD block ────────────────────────────────────────
    # Per-restaurant scalars in one pass. We COUNT sessions and
    # SUM bill totals grouped by restaurant, then join names.
    lb = await db.execute(
        select(
            Restaurant.id,
            Restaurant.name,
            func.count(distinct(MealSession.id)).label("sessions_count"),
            func.count(distinct(Reward.id)).label("rewards_count"),
            func.coalesce(func.sum(Bill.total_minor), 0).label("revenue"),
        )
        .join(MealSession, MealSession.restaurant_id == Restaurant.id, isouter=True)
        .join(Reward, Reward.meal_session_id == MealSession.id, isouter=True)
        .join(Bill, Bill.meal_session_id == MealSession.id, isouter=True)
        .where(
            (MealSession.started_at >= since) | (MealSession.id.is_(None))
        )
        .group_by(Restaurant.id, Restaurant.name)
        .order_by(func.count(distinct(MealSession.id)).desc())
    )
    restaurants_list = [
        {
            "restaurant_id": str(row[0]),
            "name": row[1],
            "sessions": int(row[2] or 0),
            "rewards": int(row[3] or 0),
            "revenue_paise": int(row[4] or 0),
        }
        for row in lb.all()
    ]

    return {
        "range": range,
        "since": since.isoformat(),
        "generated_at": now.isoformat(),
        "summary": summary,
        "restaurants": restaurants_list,
    }


@router.get("/admin/platform/restaurants/{restaurant_id}/analytics")
async def admin_restaurant_drilldown(
    restaurant_id: UUID,
    range: str = Query(default="30d", pattern="^(7d|30d|90d|all)$"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Drill-down for a single restaurant. Focused scalars: activity,
    kg saved, revenue, disputes, staff performance summary."""
    _require_admin(user)
    restaurant = await db.get(Restaurant, restaurant_id)
    if restaurant is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")
    since = _since_for(range)

    sessions_total = await db.scalar(
        select(func.count(MealSession.id)).where(
            MealSession.restaurant_id == restaurant_id,
            MealSession.started_at >= since,
        )
    ) or 0
    sessions_rewarded = await db.scalar(
        select(func.count(MealSession.id)).where(
            MealSession.restaurant_id == restaurant_id,
            MealSession.started_at >= since,
            MealSession.status == "rewarded",
        )
    ) or 0
    sessions_cancelled = await db.scalar(
        select(func.count(MealSession.id)).where(
            MealSession.restaurant_id == restaurant_id,
            MealSession.started_at >= since,
            MealSession.status == "cancelled",
        )
    ) or 0

    validations_total = await db.scalar(
        select(func.count(StaffValidation.id)).where(
            StaffValidation.restaurant_id == restaurant_id,
            StaffValidation.decided_at >= since,
        )
    ) or 0
    validations_approved = await db.scalar(
        select(func.count(StaffValidation.id)).where(
            StaffValidation.restaurant_id == restaurant_id,
            StaffValidation.decided_at >= since,
            StaffValidation.decision.in_(("approved", "adjusted")),
        )
    ) or 0
    validations_rejected = await db.scalar(
        select(func.count(StaffValidation.id)).where(
            StaffValidation.restaurant_id == restaurant_id,
            StaffValidation.decided_at >= since,
            StaffValidation.decision == "rejected",
        )
    ) or 0

    # Sustainability, same shape as the platform summary but
    # restaurant-scoped.
    sustain_rows = await db.execute(
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
            StaffValidation.restaurant_id == restaurant_id,
            StaffValidation.decided_at >= since,
            StaffValidation.decision.in_(("approved", "adjusted")),
        )
    )
    by_session: dict[UUID, tuple[Decimal, list[tuple[str | None, int]]]] = {}
    for session_id, final_score, quantity, category in sustain_rows.all():
        score = Decimal(str(final_score))
        if session_id not in by_session:
            by_session[session_id] = (score, [])
        by_session[session_id][1].append((category, int(quantity)))
    sustain_input = [
        sustainability_svc.SessionInput(final_score=score, item_categories=items)
        for score, items in by_session.values()
    ]
    sustain = sustainability_svc.compute(
        sustain_input, period_days=_RANGES[range]
    )

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

    revenue_paise = await db.scalar(
        select(func.coalesce(func.sum(Bill.total_minor), 0)).where(
            Bill.restaurant_id == restaurant_id,
            Bill.issued_at >= since,
        )
    ) or 0
    gst_paise = await db.scalar(
        select(
            func.coalesce(
                func.sum(Bill.cgst_amount_minor + Bill.sgst_amount_minor),
                0,
            )
        ).where(
            Bill.restaurant_id == restaurant_id,
            Bill.issued_at >= since,
        )
    ) or 0

    disputes_filed = await db.scalar(
        select(func.count(Dispute.id))
        .join(MealSession, MealSession.id == Dispute.meal_session_id)
        .where(
            MealSession.restaurant_id == restaurant_id,
            Dispute.created_at >= since,
        )
    ) or 0

    # Staff summary: how many staff on the roster + which of them
    # made a decision in window. Not per-staff numbers here — the
    # dashboard already has a StaffMetrics screen for that.
    staff_on_roster = await db.scalar(
        select(func.count(RestaurantStaff.user_id)).where(
            RestaurantStaff.restaurant_id == restaurant_id
        )
    ) or 0
    staff_active = await db.scalar(
        select(func.count(distinct(StaffValidation.staff_user_id))).where(
            StaffValidation.restaurant_id == restaurant_id,
            StaffValidation.decided_at >= since,
        )
    ) or 0

    return {
        "restaurant": {
            "id": str(restaurant.id),
            "name": restaurant.name,
            "slug": restaurant.slug,
            "is_active": restaurant.is_active,
            "gstin": restaurant.gstin,
            "created_at": restaurant.created_at.isoformat(),
        },
        "range": range,
        "since": since.isoformat(),
        "generated_at": datetime.now(UTC).isoformat(),
        "activity": {
            "sessions_total": int(sessions_total),
            "sessions_rewarded": int(sessions_rewarded),
            "sessions_cancelled": int(sessions_cancelled),
            "validations_total": int(validations_total),
            "validations_approved": int(validations_approved),
            "validations_rejected": int(validations_rejected),
            "approval_rate": (
                round(int(validations_approved) / int(validations_total), 4)
                if validations_total
                else None
            ),
        },
        "sustainability": {
            "kg_food_saved": sustain.kg_food_saved,
            "kg_co2e_saved": sustain.kg_co2e_saved,
            "trees_day_equivalent": sustain.trees_day_equivalent,
        },
        "rewards": {
            "issued": int(rewards_issued),
            "redeemed": int(rewards_redeemed),
            "redemption_rate": (
                round(int(rewards_redeemed) / int(rewards_issued), 4)
                if rewards_issued
                else None
            ),
        },
        "revenue": {
            "bills_issued": None,  # not needed at drill-down; add if UI wants
            "revenue_paise": int(revenue_paise),
            "gst_paise": int(gst_paise),
        },
        "disputes": {"filed": int(disputes_filed)},
        "staff": {
            "on_roster": int(staff_on_roster),
            "active_in_window": int(staff_active),
        },
    }
