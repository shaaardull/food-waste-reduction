from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field, model_validator


class ValidationIn(BaseModel):
    decision: str = Field(pattern="^(approved|rejected|adjusted)$")
    final_score: float | None = Field(default=None, ge=0.0, le=1.0)
    reason_code: str | None = None
    notes: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def check_required(self) -> "ValidationIn":
        if self.decision == "adjusted" and self.final_score is None:
            raise ValueError("final_score is required when decision='adjusted'")
        if self.decision in ("adjusted", "rejected") and not self.reason_code:
            raise ValueError("reason_code is required for adjusted/rejected decisions")
        return self


class ValidationOut(BaseModel):
    id: UUID
    meal_session_id: UUID
    decision: str
    model_score: float
    final_score: float
    reason_code: str | None = None
    notes: str | None = None
    decided_at: datetime

    model_config = {"from_attributes": True}


class PendingValidationOut(BaseModel):
    session_id: UUID
    table_code: str
    score: float
    score_age_seconds: int
    before_image_url: str
    after_image_url: str
    ordered_items: list[dict[str, Any]]
    model_notes: str | None = None
    model_confidence: float | None = None
    suspicious: bool = False
    fraud_signals: list[dict[str, Any]]


class EscalateIn(BaseModel):
    notes: str = Field(min_length=1, max_length=500)
