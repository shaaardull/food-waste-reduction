"""Walk-in waitlist / door queue.

Distinct from meal_sessions — a waitlist entry is a group of guests
asking to be seated, not a meal in progress. Once staff hits Seat the
diner starts a normal meal_session via a table QR or walk-in flow.

Two surfaces:

* Public, no-auth: guest scans the per-restaurant Waitlist QR sticker,
  hits ``POST /restaurants/{slug}/waitlist``, then polls
  ``GET /waitlist/{entry_id}`` for their position. Both are keyed on
  restaurant slug / entry id, so information disclosure is bounded to
  what the guest already has in their phone's URL bar.

* Staff-only: ``GET /restaurants/{id}/waitlist`` returns the queue.
  ``POST /waitlist/{entry_id}/{seat,cancel,no-show}`` moves an entry
  through the lifecycle. Owner + manager + server all allowed —
  seating people is a floor-staff action.

Rate-limit: the public POST is 10 per source IP per hour so a group
huddled around one phone doesn't get bounced. Loose on purpose.

# TODO(notification): once we ship SMS "you're up", the seat endpoint
# fires the outbound. The phone number is captured on submit for
# exactly that.
"""
from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.errors import ApiError, NotRestaurantStaff, RateLimited
from app.models.restaurant import Restaurant, RestaurantStaff
from app.models.user import User
from app.models.waitlist_entry import WaitlistEntry
from app.security import get_current_user
from app.services.cache import get_redis

router = APIRouter()


PUBLIC_SUBMIT_LIMIT_PER_HOUR = 10


class WaitlistEntryNotFound(ApiError):
    def __init__(self) -> None:
        super().__init__(
            status_code=status.HTTP_404_NOT_FOUND,
            code="WAITLIST_ENTRY_NOT_FOUND",
            message="Waitlist entry not found.",
        )


class WaitlistEntryNotWaiting(ApiError):
    def __init__(self, actual: str) -> None:
        super().__init__(
            status_code=status.HTTP_409_CONFLICT,
            code="WAITLIST_ENTRY_NOT_WAITING",
            message="This waitlist entry is no longer in the waiting queue.",
            details={"actual_status": actual},
        )


# ─────────── Schemas ───────────


class WaitlistSubmitIn(BaseModel):
    party_size: int = Field(ge=1, le=20)
    guest_name: str = Field(min_length=1, max_length=120)
    guest_email: EmailStr | None = None
    guest_phone: str | None = Field(default=None, max_length=32)
    notes: str | None = Field(default=None, max_length=500)


class WaitlistSubmitOut(BaseModel):
    id: UUID
    position_in_queue: int
    party_size: int
    guest_name: str
    created_at: datetime


class WaitlistPositionOut(BaseModel):
    id: UUID
    position_in_queue: int
    status: str
    created_at: datetime


class WaitlistEntryOut(BaseModel):
    id: UUID
    party_size: int
    guest_name: str
    guest_email: str | None = None
    guest_phone: str | None = None
    notes: str | None = None
    status: str
    created_at: datetime
    seated_at: datetime | None = None
    seated_by_user_id: UUID | None = None
    cancelled_at: datetime | None = None
    cancelled_reason: str | None = None


class WaitlistQueueOut(BaseModel):
    active: list[WaitlistEntryOut]
    recent: list[WaitlistEntryOut] | None = None


class WaitlistCancelIn(BaseModel):
    reason: str = Field(min_length=1, max_length=200)


# ─────────── Helpers ───────────


def _client_ip(request: Request) -> str:
    """Best-effort client IP for the public submit rate-limit. Trusts
    ``X-Forwarded-For`` when present (production sits behind an ALB /
    Nginx that sets it) and falls back to the socket peer address."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    if request.client is not None:
        return request.client.host
    return "unknown"


async def _check_public_submit_limit(ip: str) -> None:
    key = f"rl:waitlist:submit:ip:{ip}:hour"
    r = get_redis()
    pipe = r.pipeline()
    pipe.incr(key)
    pipe.expire(key, 3600, nx=True)
    count = int((await pipe.execute())[0])
    if count > PUBLIC_SUBMIT_LIMIT_PER_HOUR:
        raise RateLimited(
            details={"limit": PUBLIC_SUBMIT_LIMIT_PER_HOUR, "window": "1h"}
        )


async def _require_staff(
    db: AsyncSession, user: User, restaurant_id: UUID
) -> None:
    """Owner/manager/server all seat people. Admin bypasses. Diners and
    cross-restaurant staff get ``NOT_RESTAURANT_STAFF``."""
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


async def _position_for(
    db: AsyncSession, entry: WaitlistEntry
) -> int:
    """1 = next up. Position of a seated / cancelled / no_show entry
    is defined as its final position at seat time (1) so the diner UI
    can render a coherent "You were #1 — you're up!" state without
    another lookup. For a waiting entry it's the live count of earlier
    still-waiting siblings + 1."""
    if entry.status != "waiting":
        return 1
    count = await db.scalar(
        select(func.count(WaitlistEntry.id)).where(
            WaitlistEntry.restaurant_id == entry.restaurant_id,
            WaitlistEntry.status == "waiting",
            WaitlistEntry.created_at < entry.created_at,
        )
    )
    return int(count or 0) + 1


def _serialize(entry: WaitlistEntry) -> WaitlistEntryOut:
    return WaitlistEntryOut(
        id=entry.id,
        party_size=entry.party_size,
        guest_name=entry.guest_name,
        guest_email=entry.guest_email,
        guest_phone=entry.guest_phone,
        notes=entry.notes,
        status=entry.status,
        created_at=entry.created_at,
        seated_at=entry.seated_at,
        seated_by_user_id=entry.seated_by_user_id,
        cancelled_at=entry.cancelled_at,
        cancelled_reason=entry.cancelled_reason,
    )


# ─────────── Public endpoints ───────────


@router.post(
    "/restaurants/{slug}/waitlist",
    response_model=WaitlistSubmitOut,
    status_code=status.HTTP_201_CREATED,
)
async def public_submit(
    slug: str,
    payload: WaitlistSubmitIn,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> WaitlistSubmitOut:
    await _check_public_submit_limit(_client_ip(request))

    res = await db.execute(select(Restaurant).where(Restaurant.slug == slug))
    restaurant = res.scalar_one_or_none()
    if restaurant is None or not restaurant.is_active:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    entry = WaitlistEntry(
        restaurant_id=restaurant.id,
        party_size=payload.party_size,
        guest_name=payload.guest_name.strip(),
        guest_email=payload.guest_email,
        guest_phone=(payload.guest_phone or "").strip() or None,
        notes=(payload.notes or "").strip() or None,
        status="waiting",
    )
    db.add(entry)
    await db.commit()
    await db.refresh(entry)

    position = await _position_for(db, entry)
    return WaitlistSubmitOut(
        id=entry.id,
        position_in_queue=position,
        party_size=entry.party_size,
        guest_name=entry.guest_name,
        created_at=entry.created_at,
    )


@router.get(
    "/waitlist/{entry_id}",
    response_model=WaitlistPositionOut,
)
async def public_poll(
    entry_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> WaitlistPositionOut:
    entry = await db.get(WaitlistEntry, entry_id)
    if entry is None:
        raise WaitlistEntryNotFound()
    position = await _position_for(db, entry)
    return WaitlistPositionOut(
        id=entry.id,
        position_in_queue=position,
        status=entry.status,
        created_at=entry.created_at,
    )


@router.post(
    "/waitlist/{entry_id}/guest-cancel",
    response_model=WaitlistEntryOut,
)
async def guest_cancel(
    entry_id: UUID,
    payload: WaitlistCancelIn,
    db: AsyncSession = Depends(get_db),
) -> WaitlistEntryOut:
    """Public "leave the waitlist" action. Only allowed on entries
    still ``waiting`` — a guest can't retroactively cancel someone
    else's seated group, and the entry id is the caller's own (stored
    in their sessionStorage under ``waitlist-entry-{slug}``)."""
    entry = await db.get(WaitlistEntry, entry_id)
    if entry is None:
        raise WaitlistEntryNotFound()
    if entry.status != "waiting":
        raise WaitlistEntryNotWaiting(actual=entry.status)
    entry.status = "cancelled"
    entry.cancelled_at = datetime.now(UTC)
    entry.cancelled_reason = payload.reason.strip() or "guest_cancelled"
    await db.commit()
    await db.refresh(entry)
    return _serialize(entry)


# ─────────── Staff endpoints ───────────


@router.get(
    "/restaurants/{restaurant_id}/waitlist",
    response_model=WaitlistQueueOut,
)
async def staff_list(
    restaurant_id: UUID,
    include_recent: bool = Query(default=False),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WaitlistQueueOut:
    await _require_staff(db, user, restaurant_id)

    active_res = await db.execute(
        select(WaitlistEntry)
        .where(
            WaitlistEntry.restaurant_id == restaurant_id,
            WaitlistEntry.status == "waiting",
        )
        .order_by(WaitlistEntry.created_at.asc())
    )
    active = [_serialize(r) for r in active_res.scalars().all()]

    recent: list[WaitlistEntryOut] | None = None
    if include_recent:
        # Today in UTC — the pilot restaurants are all IST so this is a
        # ~5.5h shift from local midnight, which is acceptable for a
        # "recently cleared" panel. If a restaurant wants their own
        # local-day window we'll add a tz-aware variant later.
        today_start = datetime.now(UTC).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        recent_res = await db.execute(
            select(WaitlistEntry)
            .where(
                WaitlistEntry.restaurant_id == restaurant_id,
                WaitlistEntry.status.in_(("seated", "cancelled", "no_show")),
                or_(
                    and_(
                        WaitlistEntry.seated_at.is_not(None),
                        WaitlistEntry.seated_at >= today_start,
                    ),
                    and_(
                        WaitlistEntry.cancelled_at.is_not(None),
                        WaitlistEntry.cancelled_at >= today_start,
                    ),
                ),
            )
            .order_by(
                func.coalesce(
                    WaitlistEntry.seated_at, WaitlistEntry.cancelled_at
                ).desc()
            )
            .limit(50)
        )
        recent = [_serialize(r) for r in recent_res.scalars().all()]

    return WaitlistQueueOut(active=active, recent=recent)


async def _load_entry_for_staff(
    db: AsyncSession, user: User, entry_id: UUID
) -> WaitlistEntry:
    entry = await db.get(WaitlistEntry, entry_id)
    if entry is None:
        raise WaitlistEntryNotFound()
    await _require_staff(db, user, entry.restaurant_id)
    return entry


@router.post(
    "/waitlist/{entry_id}/seat",
    response_model=WaitlistEntryOut,
)
async def staff_seat(
    entry_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WaitlistEntryOut:
    entry = await _load_entry_for_staff(db, user, entry_id)
    if entry.status != "waiting":
        raise WaitlistEntryNotWaiting(actual=entry.status)
    entry.status = "seated"
    entry.seated_at = datetime.now(UTC)
    entry.seated_by_user_id = user.id
    # TODO(notification): fire "you're up" outbound to guest_phone /
    # guest_email here once we ship it. Pilot restaurants call
    # physically today.
    await db.commit()
    await db.refresh(entry)
    return _serialize(entry)


@router.post(
    "/waitlist/{entry_id}/cancel",
    response_model=WaitlistEntryOut,
)
async def staff_cancel(
    entry_id: UUID,
    payload: WaitlistCancelIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WaitlistEntryOut:
    entry = await _load_entry_for_staff(db, user, entry_id)
    if entry.status != "waiting":
        raise WaitlistEntryNotWaiting(actual=entry.status)
    entry.status = "cancelled"
    entry.cancelled_at = datetime.now(UTC)
    entry.cancelled_reason = payload.reason.strip()
    await db.commit()
    await db.refresh(entry)
    return _serialize(entry)


@router.post(
    "/waitlist/{entry_id}/no-show",
    response_model=WaitlistEntryOut,
)
async def staff_no_show(
    entry_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WaitlistEntryOut:
    entry = await _load_entry_for_staff(db, user, entry_id)
    if entry.status != "waiting":
        raise WaitlistEntryNotWaiting(actual=entry.status)
    entry.status = "no_show"
    entry.seated_at = None
    # cancelled_at repurposed as "cleared-from-queue-at" — the
    # recently-cleared panel needs a timestamp to sort by.
    entry.cancelled_at = datetime.now(UTC)
    await db.commit()
    await db.refresh(entry)
    return _serialize(entry)
