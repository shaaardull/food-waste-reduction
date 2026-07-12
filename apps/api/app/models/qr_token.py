"""QRToken model — pre-printed sticker inventory.

See migration 0014 for the operational model. Kept flat on purpose —
no per-token image blob (that lives in the printed PDF from the CLI),
no audit-log join (the state + assigned_at fields carry enough for
pilot-scale ops).
"""
from datetime import datetime
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin

QR_STATES = ("unassigned", "assigned", "retired")


class QRToken(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "qr_tokens"
    __table_args__ = (
        CheckConstraint(
            "state IN ('unassigned', 'assigned', 'retired')",
            name="qr_tokens_state_check",
        ),
        Index("ix_qr_tokens_state_created", "state", "created_at"),
        Index("ix_qr_tokens_batch", "batch_label"),
    )

    token: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    batch_label: Mapped[str | None] = mapped_column(String(64), nullable=True)
    state: Mapped[str] = mapped_column(
        String(16), nullable=False, default="unassigned", server_default="unassigned"
    )
    restaurant_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("restaurants.id", ondelete="SET NULL"),
        nullable=True,
    )
    table_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    assigned_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
