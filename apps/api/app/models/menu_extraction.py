"""Menu-extraction audit log.

Every time staff uploads a menu-card photo and Claude Vision returns
proposed items, we persist the run here — image key, model version,
raw structured output, and how many of the proposed rows the staff
actually accepted into `menu_items`. Cheap to keep, invaluable for
tuning the prompt when a restaurant reports "the model got the
paneer tikka price wrong."

Not linked FK-cascade to `menu_items` — the extraction outlives the
items it proposed. Rows expire on the standard image-retention job
alongside plate captures.
"""
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin


class MenuExtraction(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "menu_extractions"

    restaurant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("restaurants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    staff_user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Where the source menu-card photo lives in object storage. Nullable
    # so the row can survive the retention purge while keeping the audit
    # trail (item counts + raw output).
    image_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)
    model_name: Mapped[str] = mapped_column(String, nullable=False)
    model_version: Mapped[str] = mapped_column(String, nullable=False)
    # Full tool-call payload from Claude, verbatim. Useful for prompt
    # tuning and for the "the model got Xyz wrong" debug path.
    raw_output: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    # How many proposed rows the staff actually confirmed into the
    # `menu_items` table. Zero means "the extraction was rejected in
    # review" — a strong tuning signal.
    items_proposed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    items_accepted: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    processing_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    extracted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
