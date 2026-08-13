"""Consent recording + lookup service.

Central helpers for anything that needs to (a) look up the currently
effective version of a legal document, (b) verify a client-supplied
version matches, or (c) append an accept/withdraw event to
user_consents. The signup middleware, the settings toggle endpoint,
and the capture-time research-consent snapshot all sit on top of these.

Nothing here commits the session — callers own their transaction so
consent events can be recorded atomically with the user creation or
capture insertion that triggered them.
"""
from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import ApiError
from app.models.consent import (
    CONSENT_ACTIONS,
    CONSENT_CONTEXTS,
    DOCUMENT_TYPES,
    DocumentVersion,
    UserConsent,
)


async def get_current_version(
    db: AsyncSession, document_type: str
) -> DocumentVersion | None:
    """Return the highest effective_from version of `document_type`
    whose effective_from is already in the past. Returns None only if
    the document has never been published, which is a configuration
    error the caller should treat as fatal."""
    if document_type not in DOCUMENT_TYPES:
        raise ValueError(f"Unknown document_type {document_type!r}")
    now = datetime.now(UTC)
    result = await db.execute(
        select(DocumentVersion)
        .where(
            DocumentVersion.document_type == document_type,
            DocumentVersion.effective_from <= now,
        )
        .order_by(DocumentVersion.effective_from.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def require_current_version(
    db: AsyncSession, document_type: str
) -> DocumentVersion:
    """Same as get_current_version but raises 500 if the document has
    never been published. Signup middleware uses this so a fresh
    install with an unseeded document_versions table fails loudly
    instead of silently letting people through."""
    version = await get_current_version(db, document_type)
    if version is None:
        raise ApiError(
            status_code=500,
            code="DOCUMENT_NOT_PUBLISHED",
            message=(
                f"No current version of {document_type} is published. "
                "The database seeder must run before this endpoint."
            ),
        )
    return version


async def verify_client_version(
    db: AsyncSession, document_type: str, client_version: str
) -> DocumentVersion:
    """Confirm the version the client claims to have accepted matches
    the currently effective one. This guards against a stale cached
    signup form silently accepting an old ToS after we publish an
    amendment. Returns the DocumentVersion row on success."""
    current = await require_current_version(db, document_type)
    if current.version != client_version:
        raise ApiError(
            status_code=409,
            code="STALE_DOCUMENT_VERSION",
            message=(
                f"Your app has an outdated version of {document_type}. "
                f"Please refresh and accept the current version "
                f"({current.version})."
            ),
        )
    return current


def _client_meta(request: Request | None) -> tuple[str | None, str | None]:
    """Best-effort IP + user-agent extraction. Both are optional in
    the DB; if we can't get them we record NULL rather than fabricate
    something. Behind Cloudflare the true client IP is in the
    CF-Connecting-IP header — we prefer that when present."""
    if request is None:
        return None, None
    ip = (
        request.headers.get("cf-connecting-ip")
        or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or (request.client.host if request.client else None)
    )
    ua = request.headers.get("user-agent")
    return (ip or None), (ua or None)


async def record_consent(
    db: AsyncSession,
    *,
    user_id: UUID,
    document_version: DocumentVersion,
    action: str,
    context: str,
    request: Request | None = None,
    notes: str | None = None,
) -> UserConsent:
    """Append an accept/withdraw row. Caller is responsible for
    committing the transaction. Idempotency is *not* enforced here —
    two accepts of the same version look no different from one, which
    matches the audit-log semantics we want (every click gets recorded)."""
    if action not in CONSENT_ACTIONS:
        raise ValueError(f"Unknown action {action!r}")
    if context not in CONSENT_CONTEXTS:
        raise ValueError(f"Unknown context {context!r}")
    ip, ua = _client_meta(request)
    row = UserConsent(
        user_id=user_id,
        document_version_id=document_version.id,
        document_type=document_version.document_type,
        action=action,
        created_at=datetime.now(UTC),
        ip_address=ip,
        user_agent=ua,
        context=context,
        notes=notes,
    )
    db.add(row)
    return row


async def has_active_research_consent(db: AsyncSession, user_id: UUID) -> bool:
    """Return True iff the user's most recent research_consent event
    is action='accepted'. Used at plate-capture time to freeze the
    research_consent_at_capture flag on the capture row."""
    result = await db.execute(
        select(UserConsent.action)
        .where(
            UserConsent.user_id == user_id,
            UserConsent.document_type == "research_consent",
        )
        .order_by(UserConsent.created_at.desc())
        .limit(1)
    )
    latest = result.scalar_one_or_none()
    return latest == "accepted"
