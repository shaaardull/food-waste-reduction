from datetime import datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin


class StaffMetricsSnapshot(Base, UUIDPKMixin, TimestampMixin):
    """Weekly snapshot of a staff member's validation behaviour.

    Used by the 4-week-rolling alert in ethics rule 8 (CLAUDE.md §8): if a
    staff member's rejection rate exceeds 2× the restaurant median for 4
    weeks running, an alert is raised.
    """

    __tablename__ = "staff_metrics_snapshots"
    __table_args__ = (
        UniqueConstraint(
            "staff_user_id", "period_start", name="uq_staff_metrics_user_period"
        ),
    )

    staff_user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    restaurant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False, index=True
    )
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    validations_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    approvals_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rejections_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    adjustments_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rejection_rate: Mapped[Decimal] = mapped_column(Numeric(5, 4), nullable=False, default=0)
    approval_rate: Mapped[Decimal] = mapped_column(Numeric(5, 4), nullable=False, default=0)
    restaurant_median_rejection_rate: Mapped[Decimal] = mapped_column(
        Numeric(5, 4), nullable=False, default=0
    )
