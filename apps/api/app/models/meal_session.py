from datetime import datetime
from uuid import UUID

from sqlalchemy import Boolean, CheckConstraint, DateTime, Float, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin

VALID_STATUSES = (
    "open",
    "before_captured",
    "eating",
    "after_submitted",
    "scored",
    "pending_staff_validation",
    "staff_approved",
    "staff_rejected",
    "rewarded",
    "expired",
    "disputed",
    "cancelled",
    # Walk-in additions (migration 0016)
    "voided",
    "serving",
    "served",
    "billed",
    "paid",
)


class MealSession(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "meal_sessions"
    __table_args__ = (
        CheckConstraint(
            "status IN ("
            "'open','before_captured','eating','after_submitted','scored',"
            "'pending_staff_validation','staff_approved','staff_rejected',"
            "'rewarded','expired','disputed','cancelled','voided','serving',"
            "'served','billed','paid')",
            name="meal_sessions_status_check",
        ),
        CheckConstraint(
            "entry_channel IN ('qr','walkin')",
            name="meal_sessions_entry_channel_check",
        ),
        Index("ix_meal_sessions_diner_started", "diner_user_id", "started_at"),
        Index("ix_meal_sessions_restaurant_status_started", "restaurant_id", "status", "started_at"),
        Index(
            "ix_meal_sessions_pending_validation",
            "restaurant_id",
            "status",
            postgresql_where="status = 'pending_staff_validation'",
        ),
    )

    # Nullable since migration 0016 — walk-in sessions have no diner
    # account; staff enter them at the counter.
    diner_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    restaurant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False
    )
    table_code: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default="open")
    # 'qr' for diner-scanned sessions, 'walkin' for staff-entered ones.
    # Walk-ins are billed but never receive rewards.
    entry_channel: Mapped[str] = mapped_column(
        String, nullable=False, default="qr", server_default="qr"
    )
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    client_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    client_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    device_fingerprint: Mapped[str | None] = mapped_column(String, nullable=True)
    escalated: Mapped[bool] = mapped_column(default=False, nullable=False, server_default="false")
    # Sprint Gap-C decision: cosmetic kitchen acknowledgement. Non-null
    # when a staff member taps "Mark sent" on the Orders dashboard; the
    # diner flow doesn't gate on it. If null, the order lives in the
    # NEW ORDERS column; once set, it moves to PREPARING.
    kitchen_ack_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Sprint E: staff can cancel a session at any stage. The reason is
    # surfaced to the diner on SessionStatus (ethics rule 9 — diner
    # recourse). Both nullable so old sessions that never got cancelled
    # simply carry NULL/NULL.
    cancelled_reason: Mapped[str | None] = mapped_column(String, nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Walk-in additions (migration 0016). Optional paperless-bill
    # contact captured on Step 3 of the walk-in flow; audit trail for
    # void/paid actions.
    customer_email: Mapped[str | None] = mapped_column(String, nullable=True)
    customer_phone: Mapped[str | None] = mapped_column(String, nullable=True)
    voided_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    voided_reason: Mapped[str | None] = mapped_column(String, nullable=True)
    voided_by_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    paid_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Takeaway walk-ins (migration 0017). Sub-flavor of walk-in: no
    # physical table, so create synthesises a TAKEAWAY-XXXXXX code.
    is_takeaway: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )


class MealSessionItem(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "meal_session_items"
    __table_args__ = (
        CheckConstraint(
            "portion_size IS NULL OR portion_size IN ('small', 'regular', 'large')",
            name="meal_session_items_portion_check",
        ),
    )

    meal_session_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("meal_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    menu_item_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("menu_items.id"), nullable=False
    )
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    portion_size: Mapped[str | None] = mapped_column(String, nullable=True)
    notes: Mapped[str | None] = mapped_column(String, nullable=True)
