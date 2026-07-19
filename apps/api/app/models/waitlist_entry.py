"""WaitlistEntry — a walk-in guest waiting for a table.

See migration 0021 for the lifecycle notes. Kept flat like
RestaurantTable — the queue screen is a straightforward status-driven
list and doesn't need relationships.

# TODO(notification): pilot restaurants call guests physically. When
# an SMS/WhatsApp "you're up" nudge lands, it hooks in the seat
# endpoint (routers/waitlist.py) — the phone number is already
# captured here for exactly that.
"""
from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Index, Integer, Text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin


class WaitlistEntry(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "waitlist_entries"
    __table_args__ = (
        Index(
            "ix_waitlist_restaurant_status_created",
            "restaurant_id",
            "status",
            "created_at",
        ),
    )

    restaurant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("restaurants.id", ondelete="CASCADE"),
        nullable=False,
    )
    party_size: Mapped[int] = mapped_column(Integer, nullable=False)
    guest_name: Mapped[str] = mapped_column(Text, nullable=False)
    guest_email: Mapped[str | None] = mapped_column(Text, nullable=True)
    guest_phone: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="waiting", server_default="waiting"
    )
    seated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    seated_by_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    cancelled_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
