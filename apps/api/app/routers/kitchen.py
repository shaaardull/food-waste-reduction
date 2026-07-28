"""Kitchen Display System (KDS) — endpoints the /kitchen dashboard
screen and the auto-print loop hit.

Three families:

* Queue read: ``GET /restaurants/:id/kitchen/queue`` returns every
  session with at least one item not yet ``served``, grouped by
  station. This is the KDS's main data source; it polls every few
  seconds and re-renders the cards.

* Per-item lifecycle: ``PATCH /kitchen/items/:id/status`` moves one
  ``meal_session_items`` row through queued → fired → ready →
  served. Server enforces the forward-only transition so a stale
  tap doesn't accidentally regress state.

* KOT events: ``GET /restaurants/:id/kitchen/events`` returns
  kot_events since a supplied cursor for the auto-print loop, and
  ``POST /kitchen/sessions/:id/reprint`` reissues a ticket.

All endpoints are staff-only, scoped to the restaurant the caller
belongs to. Admin bypass mirrors the waitlist router.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.errors import NotRestaurantStaff
from app.models.kot_event import KotEvent
from app.models.meal_session import MealSession, MealSessionItem
from app.models.menu_item import MenuItem
from app.models.restaurant import RestaurantStaff
from app.models.user import User
from app.security import get_current_user
from app.services import kot

router = APIRouter()


# ─────────── Schemas ───────────


class KitchenItemOut(BaseModel):
    id: UUID
    menu_item_id: UUID
    name: str
    quantity: int
    portion_size: str | None
    notes: str | None
    kitchen_status: str
    fired_at: datetime | None
    ready_at: datetime | None


class KitchenCardOut(BaseModel):
    """One card in the KDS queue — one (session × station) group."""

    session_id: UUID
    table_code: str
    entry_channel: str
    is_takeaway: bool
    station: str
    started_at: datetime
    items: list[KitchenItemOut]


class KitchenQueueOut(BaseModel):
    stations: dict[str, list[KitchenCardOut]]


class KitchenStatusIn(BaseModel):
    status: str = Field(pattern="^(fired|ready|served)$")


class KotEventOut(BaseModel):
    id: UUID
    meal_session_id: UUID
    event_type: str
    station: str
    items_snapshot: list[dict[str, Any]]
    created_at: datetime
    table_code: str


class KotEventsOut(BaseModel):
    events: list[KotEventOut]
    server_now: datetime


# ─────────── Auth helper ───────────


async def _ensure_staff(
    db: AsyncSession, user: User, restaurant_id: UUID
) -> None:
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


# ─────────── Queue ───────────


# Only these statuses are visible in the kitchen: everything up to
# and including 'served'. Voided items disappear from the board.
KDS_VISIBLE_STATUSES = ("queued", "fired", "ready")


@router.get(
    "/restaurants/{restaurant_id}/kitchen/queue",
    response_model=KitchenQueueOut,
)
async def get_queue(
    restaurant_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KitchenQueueOut:
    """Return every item in the kitchen right now, grouped by station
    and then by session. Sorted oldest-first within each station so
    the leftmost card is the one the kitchen should fire next."""
    await _ensure_staff(db, user, restaurant_id)

    rows = (
        await db.execute(
            select(MealSessionItem, MenuItem, MealSession)
            .join(MenuItem, MenuItem.id == MealSessionItem.menu_item_id)
            .join(MealSession, MealSession.id == MealSessionItem.meal_session_id)
            .where(
                MealSession.restaurant_id == restaurant_id,
                MealSessionItem.kitchen_status.in_(KDS_VISIBLE_STATUSES),
                # Skip already-billed/paid — the kitchen has moved on.
                MealSession.status.notin_(
                    ("paid", "voided", "expired", "cancelled")
                ),
            )
            .order_by(MealSession.started_at)
        )
    ).all()

    # Group by (station, session)
    grouped: dict[str, dict[UUID, KitchenCardOut]] = {}
    for item, menu_item, session in rows:
        station = menu_item.kitchen_station or "hot"
        station_bucket = grouped.setdefault(station, {})
        card = station_bucket.get(session.id)
        if card is None:
            card = KitchenCardOut(
                session_id=session.id,
                table_code=session.table_code,
                entry_channel=session.entry_channel,
                is_takeaway=session.is_takeaway,
                station=station,
                started_at=session.started_at,
                items=[],
            )
            station_bucket[session.id] = card
        card.items.append(
            KitchenItemOut(
                id=item.id,
                menu_item_id=item.menu_item_id,
                name=menu_item.name,
                quantity=item.quantity,
                portion_size=item.portion_size,
                notes=item.notes,
                kitchen_status=item.kitchen_status,
                fired_at=item.fired_at,
                ready_at=item.ready_at,
            )
        )

    # Materialise into the response shape: dict[station, list[card]]
    # with cards ordered by started_at.
    stations: dict[str, list[KitchenCardOut]] = {}
    for station, bucket in grouped.items():
        stations[station] = sorted(bucket.values(), key=lambda c: c.started_at)
    return KitchenQueueOut(stations=stations)


# ─────────── Per-item transitions ───────────


_ALLOWED_TRANSITIONS = {
    "queued": {"fired"},
    "fired": {"ready"},
    "ready": {"served"},
    # served + voided are terminal — no forward path from here.
}


@router.patch(
    "/kitchen/items/{item_id}/status",
    response_model=KitchenItemOut,
)
async def transition_item_status(
    item_id: UUID,
    payload: KitchenStatusIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KitchenItemOut:
    """Advance one item through queued → fired → ready → served.
    Forward-only: a stale tap on an item another chef already
    advanced returns 409 rather than silently regressing state."""
    item = await db.get(MealSessionItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")

    session = await db.get(MealSession, item.meal_session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    await _ensure_staff(db, user, session.restaurant_id)

    allowed_next = _ALLOWED_TRANSITIONS.get(item.kitchen_status, set())
    if payload.status not in allowed_next:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "INVALID_KITCHEN_TRANSITION",
                "message": (
                    f"Cannot move item from '{item.kitchen_status}' to "
                    f"'{payload.status}'. Allowed next: {sorted(allowed_next)}."
                ),
            },
        )

    now = datetime.now(UTC)
    item.kitchen_status = payload.status
    if payload.status == "fired":
        item.fired_at = now
    elif payload.status == "ready":
        item.ready_at = now
    await db.commit()
    await db.refresh(item)

    menu_item = await db.get(MenuItem, item.menu_item_id)
    return KitchenItemOut(
        id=item.id,
        menu_item_id=item.menu_item_id,
        name=menu_item.name if menu_item else "",
        quantity=item.quantity,
        portion_size=item.portion_size,
        notes=item.notes,
        kitchen_status=item.kitchen_status,
        fired_at=item.fired_at,
        ready_at=item.ready_at,
    )


# ─────────── KOT event polling + reprint ───────────


@router.get(
    "/restaurants/{restaurant_id}/kitchen/events",
    response_model=KotEventsOut,
)
async def list_events(
    restaurant_id: UUID,
    since: datetime | None = Query(
        default=None,
        description="Return events strictly newer than this timestamp",
    ),
    limit: int = Query(default=50, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KotEventsOut:
    """Cursor-paginated by ``since``. The KDS calls this on a poll
    with the timestamp of the last event it saw; a fresh row means a
    new order landed and the auto-print loop should fire a ticket."""
    await _ensure_staff(db, user, restaurant_id)

    stmt = (
        select(KotEvent, MealSession.table_code)
        .join(MealSession, MealSession.id == KotEvent.meal_session_id)
        .where(KotEvent.restaurant_id == restaurant_id)
    )
    if since is not None:
        stmt = stmt.where(KotEvent.created_at > since)
    stmt = stmt.order_by(KotEvent.created_at).limit(limit)

    rows = (await db.execute(stmt)).all()
    events = [
        KotEventOut(
            id=ev.id,
            meal_session_id=ev.meal_session_id,
            event_type=ev.event_type,
            station=ev.station,
            items_snapshot=ev.items_snapshot,
            created_at=ev.created_at,
            table_code=table_code,
        )
        for ev, table_code in rows
    ]
    return KotEventsOut(events=events, server_now=datetime.now(UTC))


class ReprintIn(BaseModel):
    station: str | None = None


@router.post(
    "/kitchen/sessions/{session_id}/reprint",
    response_model=KotEventsOut,
    status_code=status.HTTP_201_CREATED,
)
async def reprint(
    session_id: UUID,
    payload: ReprintIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KotEventsOut:
    """Reissue tickets for a session, reusing the frozen
    items_snapshot from the most recent new/add_on event per station
    so the reprint is byte-identical to the original."""
    session = await db.get(MealSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    await _ensure_staff(db, user, session.restaurant_id)

    reprints = await kot.emit_reprint(
        db,
        session=session,
        triggered_by_user_id=user.id,
        station=payload.station,
    )
    if not reprints:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "NOTHING_TO_REPRINT",
                "message": "No KOT has ever been printed for this session yet.",
            },
        )
    await db.commit()
    return KotEventsOut(
        events=[
            KotEventOut(
                id=rp.id,
                meal_session_id=rp.meal_session_id,
                event_type=rp.event_type,
                station=rp.station,
                items_snapshot=rp.items_snapshot,
                created_at=rp.created_at,
                table_code=session.table_code,
            )
            for rp in reprints
        ],
        server_now=datetime.now(UTC),
    )
