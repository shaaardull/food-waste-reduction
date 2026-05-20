from datetime import datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin

REASON_CODES = (
    "plate_not_clean_enough",
    "wrong_plate_photographed",
    "food_hidden_or_discarded",
    "image_quality_issue",
    "model_overestimated",
    "model_underestimated",
    "dispute_with_diner",
    "other",
)


class StaffValidation(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "staff_validations"
    __table_args__ = (
        CheckConstraint(
            "decision IN ('approved', 'rejected', 'adjusted')",
            name="staff_validations_decision_check",
        ),
        UniqueConstraint("meal_session_id", name="uq_staff_validations_session"),
    )

    meal_session_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("meal_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    staff_user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    restaurant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False
    )
    decision: Mapped[str] = mapped_column(String, nullable=False)
    model_score: Mapped[Decimal] = mapped_column(Numeric(4, 3), nullable=False)
    final_score: Mapped[Decimal] = mapped_column(Numeric(4, 3), nullable=False)
    reason_code: Mapped[str | None] = mapped_column(String, nullable=True)
    notes: Mapped[str | None] = mapped_column(String, nullable=True)
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    decision_latency_ms: Mapped[int] = mapped_column(Integer, nullable=False)
