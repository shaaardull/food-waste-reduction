"""Bill schemas.

Bills are the diner-facing tax invoice. Frozen at issue time (GST rate
snapshot, line items snapshot) so a later menu edit or rate change
doesn't retroactively rewrite past bills. See CGST Rules §46 for the
required tax-invoice fields the response needs to carry.
"""
from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field


class BillLineItemOut(BaseModel):
    """One row on the bill. `line_total_minor` = quantity × price_minor —
    included in the response so the client doesn't have to redo the
    multiplication (and prevents client-side rounding disagreements)."""

    menu_item_id: UUID | None = None  # NULL if the menu row was hard-deleted
    name: str
    quantity: int
    portion_size: str | None = None
    price_minor: int
    line_total_minor: int


class BillOut(BaseModel):
    id: UUID
    meal_session_id: UUID
    restaurant_id: UUID
    bill_number: str
    line_items: list[BillLineItemOut]
    subtotal_minor: int
    discount_minor: int
    reward_redemption_code: str | None
    taxable_amount_minor: int
    cgst_rate: Decimal
    sgst_rate: Decimal
    cgst_amount_minor: int
    sgst_amount_minor: int
    total_minor: int
    currency: str
    delivery_email: str | None
    delivery_phone: str | None
    delivered_via: str | None
    delivery_status: str
    issued_at: datetime
    sent_at: datetime | None


class BillGenerateIn(BaseModel):
    """Optional inputs at generation time. Only reward code is
    consequential to the bill math; delivery targets get stored but
    aren't dispatched from this endpoint (Commit C wires that)."""

    apply_redemption_code: str | None = Field(default=None, max_length=32)
    delivery_email: EmailStr | None = None
    delivery_phone: str | None = Field(
        default=None, min_length=8, max_length=20, pattern=r"^[+0-9 \-]+$"
    )


class BillSendIn(BaseModel):
    """Body for POST /bills/:id/send. Wired in Commit C — the schema
    lands here so the frontend can consume it once the endpoint exists."""

    via: Literal["email", "sms", "both"]
    target_email: EmailStr | None = None
    target_phone: str | None = Field(
        default=None, min_length=8, max_length=20, pattern=r"^[+0-9 \-]+$"
    )
