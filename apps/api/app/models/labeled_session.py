"""ORM counterpart of the labeled_sessions table (Alembic 0007).

See the migration's docstring for design rationale. The labels themselves
land on disk in YOLO format, not in this table — this row is just the
breadcrumb that says "this session went through the labelling pipeline".
"""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Integer, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin


class LabeledSession(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "labeled_sessions"
    __table_args__ = (
        UniqueConstraint("meal_session_id", name="labeled_sessions_session_unique"),
    )

    meal_session_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("meal_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    exported_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    labels_imported_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    label_studio_task_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    label_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
