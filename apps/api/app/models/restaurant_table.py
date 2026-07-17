"""RestaurantTable model — the owner-managed dining table registry.

See migration 0018 for the operational model. Kept flat like qr_token —
the tables screen is a straightforward CRUD, and rendering only needs
the join to qr_tokens for the "bound / not generated" chip.
"""
from uuid import UUID

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin


class RestaurantTable(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "restaurant_tables"
    __table_args__ = (
        Index(
            "ix_restaurant_tables_restaurant_active",
            "restaurant_id",
            "is_active",
            "display_order",
        ),
    )

    restaurant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("restaurants.id", ondelete="CASCADE"),
        nullable=False,
    )
    table_code: Mapped[str] = mapped_column(String(64), nullable=False)
    seat_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=4, server_default="4"
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    qr_token_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("qr_tokens.id", ondelete="SET NULL"),
        nullable=True,
    )
    display_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
