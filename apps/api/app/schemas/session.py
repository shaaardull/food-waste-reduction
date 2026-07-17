from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class SessionCreateIn(BaseModel):
    table_code: str = Field(min_length=1, max_length=64)
    restaurant_id: UUID


class SessionItemIn(BaseModel):
    menu_item_id: UUID
    quantity: int = Field(default=1, ge=1, le=20)
    portion_size: str | None = Field(default="small", description="Default 'small' per ethics rule 2")
    notes: str | None = Field(default=None, max_length=300)


class SessionItemsIn(BaseModel):
    items: list[SessionItemIn]


class SessionItemOut(BaseModel):
    id: UUID
    menu_item_id: UUID
    quantity: int
    portion_size: str | None = None
    notes: str | None = None

    model_config = {"from_attributes": True}


class SessionOut(BaseModel):
    id: UUID
    # Nullable since migration 0016 — walk-in sessions carry no diner.
    diner_user_id: UUID | None = None
    restaurant_id: UUID
    table_code: str
    status: str
    entry_channel: str = "qr"
    started_at: datetime
    expires_at: datetime
    # E1 additions — nullable everywhere so pre-migration sessions
    # round-trip unchanged. The diner UI keys off `cancelled_reason`
    # to render the "Your order was cancelled" banner.
    cancelled_reason: str | None = None
    cancelled_at: datetime | None = None
    # Walk-in additions (migration 0016).
    customer_email: str | None = None
    customer_phone: str | None = None
    voided_at: datetime | None = None
    voided_reason: str | None = None
    paid_at: datetime | None = None
    # Takeaway walk-in (migration 0017). Sub-flavor of walk-in.
    is_takeaway: bool = False

    model_config = {"from_attributes": True}


class SessionCancelIn(BaseModel):
    """Body for POST /sessions/:id/cancel.

    The reason is free-text (staff type e.g. "kitchen ran out of
    paneer"); ethics rule 9 requires the diner see it, so we enforce
    a minimum length instead of allowing a bare cancellation."""

    reason: str = Field(min_length=4, max_length=500)


class SessionItemsReplaceIn(BaseModel):
    """Body for PATCH /sessions/:id/items — replaces the entire item
    list in one shot. Staff-only endpoint; a partial diff would be
    trickier to reason about with the immutable-bill invariant."""

    items: list[SessionItemIn]


class SessionCreateOut(BaseModel):
    session_id: UUID
    expires_at: datetime
    before_capture_nonce: str


class CaptureOut(BaseModel):
    capture_id: UUID
    image_s3_key: str
    after_capture_nonce: str | None = None
    processing_status: str | None = None


class PerItemScoreOut(BaseModel):
    dish_name: str
    consumption: float
    confidence: float
    menu_item_id: UUID | None = None


class ScoreOut(BaseModel):
    overall_score: float
    per_item_scores: list[PerItemScoreOut]
    model_name: str
    model_version: str
    processing_ms: int
    suspicious: bool = False
    confidence: float | None = None
    notes: str | None = None


class SessionDetailOut(BaseModel):
    session: SessionOut
    items: list[SessionItemOut]
    captures: list[dict[str, Any]]
    score: ScoreOut | None = None
    reward: dict[str, Any] | None = None


class DisputeIn(BaseModel):
    reason: str = Field(min_length=4, max_length=1000)


class DisputeOut(BaseModel):
    dispute_id: UUID


class WalkinSessionCreateIn(BaseModel):
    """Body for POST /sessions/walkin. Staff-only; the current-user
    dependency provides the staff identity, so nothing about the diner
    is captured — walk-ins are anonymous by design.

    Takeaway sub-flavor: pass ``is_takeaway=true`` and omit
    ``table_code``. The server synthesises a TAKEAWAY-XXXXXX code so
    each takeaway is still distinguishable in reports. Passing both
    ``is_takeaway=true`` and a ``table_code`` is rejected with 400 to
    avoid ambiguity about the intent of the record.
    """

    restaurant_id: UUID
    # Optional now — required only when is_takeaway=False. The
    # required-when / forbidden-when rule is enforced in the endpoint
    # so the error status is 400 (clearer than Pydantic's 422 for a
    # caller-driven ambiguity).
    table_code: str | None = Field(default=None, min_length=1, max_length=64)
    is_takeaway: bool = False
    # Optional paperless-bill delivery collected on Step 3 of the flow.
    # Both fields can be null (most walk-ins decline).
    customer_email: str | None = Field(default=None, max_length=254)
    customer_phone: str | None = Field(default=None, max_length=32)


class WalkinVoidIn(BaseModel):
    """Required staff reason for voiding an order (walk-in or QR).
    Same minimum length as SessionCancelIn so the diner-visible /
    audit-visible strings stay consistent."""

    reason: str = Field(min_length=4, max_length=500)
