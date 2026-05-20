from datetime import datetime
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, Float, ForeignKey, Index, Integer, String
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
)


class MealSession(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "meal_sessions"
    __table_args__ = (
        CheckConstraint(
            "status IN ("
            "'open','before_captured','eating','after_submitted','scored',"
            "'pending_staff_validation','staff_approved','staff_rejected',"
            "'rewarded','expired','disputed')",
            name="meal_sessions_status_check",
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

    diner_user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    restaurant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False
    )
    table_code: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default="open")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    client_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    client_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    device_fingerprint: Mapped[str | None] = mapped_column(String, nullable=True)
    escalated: Mapped[bool] = mapped_column(default=False, nullable=False, server_default="false")


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
