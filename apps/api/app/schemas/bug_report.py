"""Pydantic schemas for the bug-report and platform-analytics surfaces.

Split into three shapes:

- `BugReportCreateIn` — what a staff member posts. Restaurant + user
  come from the JWT/context, not the payload, so a staff can't file
  on someone else's behalf.
- `BugReportOut` — the read/response shape returned to both staff
  (their own reports, filtered) and the platform owner (all reports).
  Includes the human labels for reporter + restaurant so the admin
  card view doesn't need a second fetch to render.
- `BugReportPatchIn` — admin-only fields. Deliberately narrow: only
  `status` and `admin_notes`. Original title / description /
  severity are immutable so the audit trail stays honest.
"""
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

BugSeverity = Literal["low", "medium", "high", "critical"]
BugStatus = Literal["open", "triaging", "in_progress", "resolved", "wont_fix"]


class BugReportCreateIn(BaseModel):
    title: str = Field(min_length=4, max_length=200)
    description: str = Field(min_length=8, max_length=8000)
    severity: BugSeverity = "medium"
    # Optional — staff can attach their current restaurant context
    # if the client sends one; otherwise the endpoint auto-derives
    # from RestaurantStaff membership.
    restaurant_id: UUID | None = None


class BugReportPatchIn(BaseModel):
    status: BugStatus | None = None
    admin_notes: str | None = Field(default=None, max_length=8000)


class BugReportOut(BaseModel):
    id: UUID
    restaurant_id: UUID | None = None
    restaurant_name: str | None = None
    reported_by_user_id: UUID
    reported_by_email: str | None = None
    reported_by_display_name: str | None = None
    title: str
    description: str
    severity: BugSeverity
    status: BugStatus
    admin_notes: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
