from decimal import Decimal
from uuid import UUID

from sqlalchemy import ForeignKey, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin


class ConsumptionScore(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "consumption_scores"
    __table_args__ = (
        UniqueConstraint("meal_session_id", name="uq_consumption_scores_session"),
    )

    meal_session_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("meal_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    overall_score: Mapped[Decimal] = mapped_column(Numeric(4, 3), nullable=False)
    per_item_scores: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    model_name: Mapped[str] = mapped_column(String, nullable=False)
    model_version: Mapped[str] = mapped_column(String, nullable=False)
    processing_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    raw_model_output: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    notes: Mapped[str | None] = mapped_column(String, nullable=True)
    suspicious: Mapped[bool] = mapped_column(default=False, nullable=False, server_default="false")
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3), nullable=True)
