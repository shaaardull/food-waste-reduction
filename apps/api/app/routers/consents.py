"""Endpoints for the consent audit trail:

  GET  /api/v1/documents/{document_type}/current
       Public — returns the effective version of a legal document so the
       client can render the text next to a signup checkbox or a
       settings toggle without embedding a stale copy.

  GET  /api/v1/me/consents
       Authenticated — returns the current accept/withdraw state per
       document type for the caller. Used by the diner Settings screen
       to render the toggles in the right position.

  POST /api/v1/me/consents
       Authenticated — appends an accept/withdraw event. Version must
       match the current effective version.

  POST /api/v1/me/research-consent
       Authenticated diner-side convenience wrapper. Client sends a
       boolean; server picks up the current research_consent version
       and records the corresponding event. When flipped True -> False
       we enqueue the plate-capture retirement job (see 6.2(a) of the
       Research Consent).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.consent import DocumentVersion, UserConsent
from app.models.user import User
from app.schemas.consent import (
    ConsentState,
    DocumentVersionOut,
    MyConsentsOut,
    RecordConsentIn,
    RecordConsentOut,
    ResearchConsentToggleIn,
)
from app.security import get_current_user
from app.services import consent as consent_svc

router = APIRouter()


@router.get(
    "/documents/{document_type}/current",
    response_model=DocumentVersionOut,
)
async def get_current_document(
    document_type: str, db: AsyncSession = Depends(get_db)
) -> DocumentVersionOut:
    version = await consent_svc.require_current_version(db, document_type)
    return DocumentVersionOut.model_validate(version, from_attributes=True)


@router.get("/me/consents", response_model=MyConsentsOut)
async def my_consents(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MyConsentsOut:
    """Latest-event-per-document-type view for the caller. Backed by
    the v_current_consents SQL view but we join in the version string
    on top rather than exposing document_version_id to the client."""
    result = await db.execute(
        select(
            UserConsent.document_type,
            UserConsent.action,
            UserConsent.created_at,
            DocumentVersion.version,
        )
        .join(DocumentVersion, DocumentVersion.id == UserConsent.document_version_id)
        .where(UserConsent.user_id == user.id)
        .order_by(UserConsent.document_type, UserConsent.created_at.desc())
    )
    rows = result.all()
    latest_per_type: dict[str, ConsentState] = {}
    for doc_type, action, decided_at, version in rows:
        if doc_type in latest_per_type:
            continue  # rows are DESC per type, so the first is the latest
        latest_per_type[doc_type] = ConsentState(
            document_type=doc_type,
            accepted=(action == "accepted"),
            version=version,
            decided_at=decided_at,
        )
    return MyConsentsOut(consents=list(latest_per_type.values()))


@router.post("/me/consents", response_model=RecordConsentOut, status_code=201)
async def record_consent(
    payload: RecordConsentIn,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RecordConsentOut:
    version = await consent_svc.verify_client_version(
        db, payload.document_type, payload.version
    )
    row = await consent_svc.record_consent(
        db,
        user_id=user.id,
        document_version=version,
        action=payload.action,
        context="settings_toggle",
        request=request,
    )
    await db.commit()
    await db.refresh(row)
    return RecordConsentOut(
        consent_id=str(row.id),
        document_type=payload.document_type,
        action=payload.action,
        version=version.version,
        decided_at=row.created_at,
    )


@router.post("/me/research-consent", response_model=RecordConsentOut, status_code=201)
async def toggle_research_consent(
    payload: ResearchConsentToggleIn,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RecordConsentOut:
    """Diner-side toggle for the optional Research Consent. Flipping
    from True to False also fires the async retirement job to clear
    research_consent_at_capture on the user's historic plate_captures,
    per §6.2(a) of the Research Consent."""
    version = await consent_svc.require_current_version(db, "research_consent")
    action = "accepted" if payload.accepted else "withdrawn"

    # Read the previous state so we can decide whether to enqueue the
    # retirement job. If the user has never given research consent and
    # is now flipping to False, there is nothing to retire.
    previously_active = await consent_svc.has_active_research_consent(db, user.id)

    row = await consent_svc.record_consent(
        db,
        user_id=user.id,
        document_version=version,
        action=action,
        context="settings_toggle",
        request=request,
    )
    await db.commit()
    await db.refresh(row)

    if previously_active and not payload.accepted:
        # Fire and forget — the retirement task itself opens a fresh
        # DB session inside the worker. Deliberately not blocking the
        # response on it.
        from app.tasks.retire_research_captures import retire_research_captures

        retire_research_captures.delay(str(user.id))

    return RecordConsentOut(
        consent_id=str(row.id),
        document_type="research_consent",
        action=action,
        version=version.version,
        decided_at=row.created_at,
    )
