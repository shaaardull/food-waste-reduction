"""KotEvent — audit trail of every kitchen order ticket emitted.

See migration 0022 for full context. Each row is one printable ticket:
either a fresh order confirm ("new"), items added to a running order
("add_on"), an item voided ("void"), or a staff-triggered reprint of a
previously emitted ticket ("reprint").

Two consumers:

  * The KDS poll on the kitchen tablet subscribes to rows for this
    restaurant since ``last_seen_at``; a new row triggers the chime
    and (if enabled) window.print() of the ticket layout.

  * The audit view: reprints and voids are the two operations
    restaurant owners most often want to reconstruct during shift
    reviews. ``items_snapshot`` is frozen at emission time so a
    reprint reproduces the original ticket even after the underlying
    meal_session_items have been modified/deleted.
"""
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Index, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDPKMixin


class KotEvent(Base, UUIDPKMixin):
    __tablename__ = "kot_events"
    __table_args__ = (
        Index(
            "ix_kot_events_restaurant_created",
            "restaurant_id",
            "created_at",
        ),
    )

    meal_session_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("meal_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    restaurant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("restaurants.id", ondelete="CASCADE"),
        nullable=False,
    )
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    station: Mapped[str] = mapped_column(Text, nullable=False)
    items_snapshot: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False
    )
    triggered_by_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
