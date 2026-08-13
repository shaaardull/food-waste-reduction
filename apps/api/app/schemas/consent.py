"""Request/response shapes for the consent-related endpoints and for
the signup middleware payloads."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

DocumentType = Literal["diner_tos", "staff_tos", "research_consent", "privacy_policy"]


class DocumentVersionOut(BaseModel):
    """Public-facing view of a legal document. `content_markdown` is
    included so the client can render the exact text a user is being
    asked to accept."""

    document_type: DocumentType
    version: str
    effective_from: datetime
    content_markdown: str
    content_sha256: str


class ConsentState(BaseModel):
    """Current consent state for one document type. `version` is the
    version the user most recently acted on (may be older than the
    current one). `accepted` is False both when the user has never
    acted on the doc and when their latest action was 'withdrawn'."""

    document_type: DocumentType
    accepted: bool
    version: str | None
    decided_at: datetime | None


class MyConsentsOut(BaseModel):
    consents: list[ConsentState]


class RecordConsentIn(BaseModel):
    """Client posts this to record an accept/withdraw event from the
    settings screen. `version` must match the currently effective
    version; otherwise the request is 409'd so the client can refresh
    and show the amended text."""

    document_type: DocumentType
    action: Literal["accepted", "withdrawn"]
    version: str


class RecordConsentOut(BaseModel):
    consent_id: str
    document_type: DocumentType
    action: Literal["accepted", "withdrawn"]
    version: str
    decided_at: datetime


class ResearchConsentToggleIn(BaseModel):
    """Convenience wrapper around the Research Consent record endpoint
    for the diner settings screen. Client sends a boolean; server looks
    up the current version and records the appropriate event."""

    accepted: bool


# The two fields below are re-used inside RegisterIn (email/password
# signup) and OtpVerifyIn (phone/OTP signup) so both signup paths block
# without a valid ToS acceptance. They are extracted here so the schema
# is defined once and stays in sync.
class SignupConsentPayload(BaseModel):
    """Consent fields required on any signup path.

    - accepted_tos_version:  version of the *appropriate* ToS document
      (diner_tos for consumer signup on plateclean.in, staff_tos for
      staff signup on dashboard.plateclean.in). Which one is enforced
      by the caller based on which surface it is running for.
    - research_consent_accepted: True iff the diner ticked the optional
      Part-B checkbox at signup. Ignored for staff signup where there
      is no research-consent option.
    - research_consent_version: required and version-matched iff
      research_consent_accepted is True; otherwise ignored.
    """

    accepted_tos_version: str = Field(
        min_length=1,
        max_length=32,
        description="Version string of the ToS the user accepted at signup.",
    )
    research_consent_accepted: bool = False
    research_consent_version: str | None = Field(
        default=None, max_length=32,
        description="Required if research_consent_accepted is True.",
    )
