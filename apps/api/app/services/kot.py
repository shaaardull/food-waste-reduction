"""KOT (Kitchen Order Ticket) emission — shared across the three
endpoints that mutate the order line-items list (create, add, void).

An emission does two things atomically inside the caller's DB
transaction (we do NOT commit here — the caller owns the tx):

  1. Insert one ``kot_events`` row per distinct kitchen station
     appearing in the affected items. One order can produce two,
     three tickets — bar drinks print at the bar station's printer,
     hot food at the hot line, dessert at the pass. The KDS shows
     them as separate cards for the same reason.

  2. Snapshot the items involved into ``items_snapshot`` so a
     reprint later, or the KDS card display, can reproduce the
     ticket even if the underlying rows are later mutated.

The caller is responsible for:
  * awaiting the session/items in the same session
  * commit() after emit_new/emit_add/emit_void returns

Reprints are separate — see ``emit_reprint`` which reuses the last
``new`` event for a given (session, station) so the ticket byte
sequence is stable.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kot_event import KotEvent
from app.models.meal_session import MealSession, MealSessionItem
from app.models.menu_item import MenuItem


async def _snapshot_items(
    db: AsyncSession,
    session_items: list[MealSessionItem],
) -> dict[str, list[dict[str, Any]]]:
    """Group already-created session_items by their menu item's
    kitchen_station, materialising each into the snapshot shape KDS
    and the print template expect.
    """
    by_station: dict[str, list[dict[str, Any]]] = {}
    for si in session_items:
        mi = await db.get(MenuItem, si.menu_item_id)
        if mi is None:
            # Should not happen — FK guaranteed — but fail closed.
            continue
        station = mi.kitchen_station or "hot"
        by_station.setdefault(station, []).append(
            {
                "item_id": str(si.id),
                "menu_item_id": str(si.menu_item_id),
                "name": mi.name,
                "quantity": si.quantity,
                "portion_size": si.portion_size,
                "notes": si.notes,
            }
        )
    return by_station


async def emit_new(
    db: AsyncSession,
    *,
    session: MealSession,
    items: list[MealSessionItem],
    triggered_by_user_id: UUID | None,
) -> list[KotEvent]:
    """Order was confirmed for the first time. Emits one ``new``
    event per station."""
    return await _emit(
        db,
        session=session,
        items=items,
        event_type="new",
        triggered_by_user_id=triggered_by_user_id,
    )


async def emit_add(
    db: AsyncSession,
    *,
    session: MealSession,
    items: list[MealSessionItem],
    triggered_by_user_id: UUID | None,
) -> list[KotEvent]:
    """Items were added to a running order. Emits one ``add_on``
    event per station in the added set."""
    return await _emit(
        db,
        session=session,
        items=items,
        event_type="add_on",
        triggered_by_user_id=triggered_by_user_id,
    )


async def emit_void(
    db: AsyncSession,
    *,
    session: MealSession,
    items: list[MealSessionItem],
    triggered_by_user_id: UUID | None,
) -> list[KotEvent]:
    """Order (or specific items) was voided. Emits one ``void`` event
    per station involved so the kitchen station knows to stop
    cooking. ``items`` is the list of items being voided (may be all
    items, may be a subset for partial voids)."""
    return await _emit(
        db,
        session=session,
        items=items,
        event_type="void",
        triggered_by_user_id=triggered_by_user_id,
    )


async def _emit(
    db: AsyncSession,
    *,
    session: MealSession,
    items: list[MealSessionItem],
    event_type: str,
    triggered_by_user_id: UUID | None,
) -> list[KotEvent]:
    if not items:
        return []
    by_station = await _snapshot_items(db, items)
    now = datetime.now(UTC)
    events: list[KotEvent] = []
    for station, snapshot in by_station.items():
        ev = KotEvent(
            meal_session_id=session.id,
            restaurant_id=session.restaurant_id,
            event_type=event_type,
            station=station,
            items_snapshot=snapshot,
            triggered_by_user_id=triggered_by_user_id,
            created_at=now,
        )
        db.add(ev)
        events.append(ev)
    return events


async def emit_reprint(
    db: AsyncSession,
    *,
    session: MealSession,
    triggered_by_user_id: UUID | None,
    station: str | None = None,
) -> list[KotEvent]:
    """Reprint the most-recent ``new`` (or the most-recent ticket if
    no ``new`` exists — should be rare) for a given session. If
    ``station`` is given, reprint only that station's; otherwise
    reprint every station that has a ticket on record.

    The reprint reuses the frozen items_snapshot from the source
    event, so the ticket byte sequence is stable — nothing recomputed
    from live rows.
    """
    stmt = select(KotEvent).where(
        KotEvent.meal_session_id == session.id,
        KotEvent.event_type.in_(("new", "add_on")),
    )
    if station is not None:
        stmt = stmt.where(KotEvent.station == station)
    stmt = stmt.order_by(desc(KotEvent.created_at))
    res = await db.execute(stmt)
    all_events = res.scalars().all()

    # Keep only the most recent event per station.
    seen: set[str] = set()
    latest_per_station: list[KotEvent] = []
    for ev in all_events:
        if ev.station in seen:
            continue
        seen.add(ev.station)
        latest_per_station.append(ev)

    now = datetime.now(UTC)
    reprints: list[KotEvent] = []
    for src in latest_per_station:
        rp = KotEvent(
            meal_session_id=session.id,
            restaurant_id=session.restaurant_id,
            event_type="reprint",
            station=src.station,
            items_snapshot=src.items_snapshot,
            triggered_by_user_id=triggered_by_user_id,
            created_at=now,
        )
        db.add(rp)
        reprints.append(rp)
    return reprints
