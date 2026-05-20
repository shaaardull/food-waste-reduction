from datetime import datetime
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, Float, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin


class PlateCapture(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "plate_captures"
    __table_args__ = (
        CheckConstraint("phase IN ('before', 'after')", name="plate_captures_phase_check"),
        UniqueConstraint("meal_session_id", "phase", name="uq_plate_captures_session_phase"),
        Index("ix_plate_captures_image_hash", "image_sha256"),
    )

    meal_session_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("meal_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    phase: Mapped[str] = mapped_column(String, nullable=False)
    image_s3_key: Mapped[str] = mapped_column(String, nullable=False)
    image_sha256: Mapped[str] = mapped_column(String, nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    client_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    client_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    device_fingerprint: Mapped[str | None] = mapped_column(String, nullable=True)
    nonce: Mapped[str] = mapped_column(String, nullable=False)
