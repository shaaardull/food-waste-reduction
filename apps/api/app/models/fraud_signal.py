from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin


class FraudSignal(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "fraud_signals"
    __table_args__ = (
        CheckConstraint(
            "severity IN ('info', 'warning', 'block')", name="fraud_signals_severity_check"
        ),
        Index("ix_fraud_signals_user_created", "user_id", "created_at"),
    )

    meal_session_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("meal_sessions.id"), nullable=True, index=True
    )
    user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    signal_type: Mapped[str] = mapped_column(String, nullable=False)
    severity: Mapped[str] = mapped_column(String, nullable=False)
    details: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
