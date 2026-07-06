"""Bill — a frozen snapshot of a meal session's line items + GST.

Bills are informational (CLAUDE.md §12: no payment integration in
Phase 1). The diner pays at the counter as usual; this row is what
gets emailed / SMS'd to them and what the restaurant uses to comply
with CGST Rules §46 for a tax invoice.

Immutable-by-convention: once created, only the delivery_status
fields should change. The line items and totals are snapshots and
should never be edited — if a mistake is found we void the bill
and issue a new one (that feature isn't in this commit).
"""
from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin


class Bill(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "bills"
    __table_args__ = (
        UniqueConstraint("meal_session_id", name="uq_bills_meal_session"),
        UniqueConstraint(
            "restaurant_id", "bill_number", name="uq_bills_restaurant_number"
        ),
        CheckConstraint(
            "delivery_status IN ('pending', 'sent', 'failed')",
            name="ck_bills_delivery_status",
        ),
        CheckConstraint(
            "delivered_via IS NULL OR delivered_via IN ('email', 'sms', 'both')",
            name="ck_bills_delivered_via",
        ),
    )

    meal_session_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("meal_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    restaurant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("restaurants.id"),
        nullable=False,
        index=True,
    )
    bill_number: Mapped[str] = mapped_column(String, nullable=False)
    subtotal_minor: Mapped[int] = mapped_column(Integer, nullable=False)
    discount_minor: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    reward_redemption_code: Mapped[str | None] = mapped_column(String, nullable=True)
    taxable_amount_minor: Mapped[int] = mapped_column(Integer, nullable=False)
    cgst_rate: Mapped[Decimal] = mapped_column(Numeric(4, 3), nullable=False)
    sgst_rate: Mapped[Decimal] = mapped_column(Numeric(4, 3), nullable=False)
    cgst_amount_minor: Mapped[int] = mapped_column(Integer, nullable=False)
    sgst_amount_minor: Mapped[int] = mapped_column(Integer, nullable=False)
    total_minor: Mapped[int] = mapped_column(Integer, nullable=False)
    currency: Mapped[str] = mapped_column(
        String, nullable=False, default="INR", server_default="INR"
    )
    line_items_json: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False
    )
    delivery_email: Mapped[str | None] = mapped_column(String, nullable=True)
    delivery_phone: Mapped[str | None] = mapped_column(String, nullable=True)
    delivered_via: Mapped[str | None] = mapped_column(String, nullable=True)
    delivery_status: Mapped[str] = mapped_column(
        String, nullable=False, default="pending", server_default="pending"
    )
    delivery_error: Mapped[str | None] = mapped_column(String, nullable=True)
    issued_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    sent_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
