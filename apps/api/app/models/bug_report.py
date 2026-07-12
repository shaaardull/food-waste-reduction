"""BugReport model — restaurant-staff issue reports.

Small, flat shape. The lifecycle is deliberately linear
(open → triaging → in_progress → resolved/wont_fix), no re-open
transition — if something regresses, staff file a fresh report so the
timeline stays clean per incident.
"""
from datetime import datetime
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin

SEVERITIES = ("low", "medium", "high", "critical")
STATUSES = ("open", "triaging", "in_progress", "resolved", "wont_fix")


class BugReport(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "bug_reports"
    __table_args__ = (
        CheckConstraint(
            "severity IN ('low', 'medium', 'high', 'critical')",
            name="bug_reports_severity_check",
        ),
        CheckConstraint(
            "status IN ('open', 'triaging', 'in_progress', 'resolved', 'wont_fix')",
            name="bug_reports_status_check",
        ),
        Index("ix_bug_reports_status_created", "status", "created_at"),
        Index("ix_bug_reports_restaurant", "restaurant_id"),
    )

    restaurant_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("restaurants.id", ondelete="SET NULL"),
        nullable=True,
    )
    reported_by_user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="open", server_default="open"
    )
    admin_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
