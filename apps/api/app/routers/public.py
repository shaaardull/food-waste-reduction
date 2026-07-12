"""Public, unauthed aggregate-stats endpoint for the marketing page.

Phase 3 §9 bullet from CLAUDE.md: "Public analytics page (aggregate,
no PII)." A stranger can hit /stats on the diner PWA and see how much
food the platform has kept out of the bin. Numbers only — no
restaurant names, no per-restaurant breakdown, no diner counts.

K-anonymity gate
- We deliberately don't emit numbers from datasets that are too small
  to anonymise. Below MIN_RESTAURANTS or MIN_SESSIONS, every scalar
  is null and `k_anonymous` is false. The frontend treats that as a
  "checking back later" empty state.
- This protects single-restaurant pilots where the impact figure
  would effectively be one restaurant's number — defeats the
  aggregation purpose.

What's deliberately NOT here
- No restaurant names, slugs, addresses, or counts of individual
  restaurants (only a single integer for "restaurants active").
- No per-restaurant breakdown.
- No diner counts.
- No sessions list, no top-dishes (could identify specialised cuisine).
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.meal_session import MealSession, MealSessionItem
from app.models.menu_item import MenuItem
from app.models.reward import Reward
from app.models.staff_validation import StaffValidation
from app.services import sustainability as sustainability_svc

router = APIRouter()

# K-anonymity gate: only emit numbers from datasets at least this large.
# Tunable — lower bound is set so a 2-restaurant pilot can pass.
MIN_RESTAURANTS_FOR_PUBLIC_STATS = 2
MIN_SESSIONS_FOR_PUBLIC_STATS = 10

# "all" maps to a very wide window so we don't need a separate
# branch — 10 years easily covers any plausible operating history.
ALL_TIME_DAYS = 365 * 10
SUPPORTED_RANGES = {"30d": 30, "90d": 90, "all": ALL_TIME_DAYS}


@router.get("/stats")
async def public_stats(
    range: str = Query(default="30d", pattern="^(30d|90d|all)$"),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Aggregate sustainability + activity scalars for the public page.

    Public — no auth. Caller controls the time window but cannot pick
    a restaurant. Below the k-anonymity floor (`k_anonymous=false`),
    every scalar is null so a tiny pilot can't be re-identified."""
    days = SUPPORTED_RANGES[range]
    since = datetime.now(UTC) - timedelta(days=days)
    now = datetime.now(UTC)

    # How many distinct restaurants ran an approved validation in the
    # window. This is the k of k-anonymity.
    restaurants_active = (
        await db.scalar(
            select(func.count(distinct(StaffValidation.restaurant_id))).where(
                StaffValidation.decided_at >= since,
                StaffValidation.decision.in_(("approved", "adjusted")),
            )
        )
        or 0
    )

    # Sustainability inputs: every (session, score, item) tuple for
    # approved/adjusted sessions in window, grouped by session for
    # services.sustainability.compute().
    rows = await db.execute(
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
    for session_id, final_score, quantity, category in rows.all():
        score = Decimal(str(final_score))
        if session_id not in by_session:
            by_session[session_id] = (score, [])
        by_session[session_id][1].append((category, int(quantity)))

    sessions_counted = len(by_session)
    sustain_input = [
        sustainability_svc.SessionInput(final_score=score, item_categories=items)
        for score, items in by_session.values()
    ]
    sustain = sustainability_svc.compute(sustain_input, period_days=days)

    # Rewards: scalars only. Don't expose per-restaurant breakdowns.
    rewards_issued = await db.scalar(
        select(func.count(Reward.id)).where(Reward.issued_at >= since)
    ) or 0
    rewards_redeemed = await db.scalar(
        select(func.count(Reward.id)).where(
            Reward.issued_at >= since, Reward.redeemed_at.is_not(None)
        )
    ) or 0

    k_anonymous = (
        restaurants_active >= MIN_RESTAURANTS_FOR_PUBLIC_STATS
        and sessions_counted >= MIN_SESSIONS_FOR_PUBLIC_STATS
    )

    # `restaurants_active` is deliberately NOT in the response —
    # even the aggregate count is business-sensitive at pilot scale.
    # We still USE it (above) for the k-anonymity gate; we just don't
    # expose it to callers. `k_anonymity_floor` is likewise omitted
    # so no reverse-subtraction attack can recover the active count
    # from "we need N more to publish."
    base = {
        "range": range,
        "period_days": days if range != "all" else None,
        "sessions_counted": sessions_counted,
        "k_anonymous": k_anonymous,
        "generated_at": now.isoformat(),
    }
    if not k_anonymous:
        base.update(
            {
                "kg_food_saved": None,
                "kg_co2e_saved": None,
                "trees_day_equivalent": None,
                "rewards_issued": None,
                "rewards_redeemed": None,
            }
        )
    else:
        base.update(
            {
                "kg_food_saved": sustain.kg_food_saved,
                "kg_co2e_saved": sustain.kg_co2e_saved,
                "trees_day_equivalent": sustain.trees_day_equivalent,
                "rewards_issued": int(rewards_issued),
                "rewards_redeemed": int(rewards_redeemed),
            }
        )
    return base
