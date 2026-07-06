"""Bill lookup by bill_id.

Session-scoped generation + retrieval live on the sessions router
(POST/GET /sessions/:id/bill). This module adds a direct `/bills/:id`
GET for cases where the caller already has the bill_id — the email
delivery link, or the staff dashboard's bill history — and doesn't
want to round-trip through the session id.
"""
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.bill import Bill
from app.models.meal_session import MealSession
from app.models.user import User
from app.routers.sessions import _bill_to_out, _user_can_access_session_bill
from app.schemas.bill import BillOut, BillSendIn
from app.security import get_current_user

router = APIRouter()


@router.get("/{bill_id}", response_model=BillOut)
async def get_bill_by_id(
    bill_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Fetch a bill directly by id. Access mirrors the session-scoped
    endpoint: diner (own session), any staff of the same restaurant,
    admin."""
    bill = await db.get(Bill, bill_id)
    if bill is None:
        raise HTTPException(status_code=404, detail="Bill not found")
    session = await db.get(MealSession, bill.meal_session_id)
    if session is None:
        # Orphaned bill — parent session got hard-deleted somehow. Serve
        # a 404 to the caller rather than a confusing 500.
        raise HTTPException(status_code=404, detail="Bill's session not found")
    if not await _user_can_access_session_bill(db, user, session):
        raise HTTPException(
            status_code=403, detail="Not authorized to view this bill"
        )
    return _bill_to_out(bill)


@router.post("/{bill_id}/send", status_code=status.HTTP_202_ACCEPTED)
async def send_bill(
    bill_id: UUID,
    payload: BillSendIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """Trigger delivery of the bill via email / SMS / both.

    Enqueues a Celery task and returns 202 immediately; the delivery
    outcome lands on the bill row's `delivery_status` field, readable
    via GET /bills/:id. Rerunning this endpoint is fine — a diner
    tapping "resend" is a normal path.

    Access mirrors GET /bills/:id — diner (own session), any staff of
    the same restaurant, admin.
    """
    bill = await db.get(Bill, bill_id)
    if bill is None:
        raise HTTPException(status_code=404, detail="Bill not found")
    session = await db.get(MealSession, bill.meal_session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Bill's session not found")
    if not await _user_can_access_session_bill(db, user, session):
        raise HTTPException(
            status_code=403, detail="Not authorized to send this bill"
        )

    # Recipient resolution: prefer explicit target on the payload,
    # then fall back to whatever was snapshotted on the bill at
    # generation time. 400 with a clear message if neither is present.
    target_email = payload.target_email or bill.delivery_email
    target_phone = payload.target_phone or bill.delivery_phone
    if payload.via in ("email", "both") and not target_email:
        raise HTTPException(
            status_code=400,
            detail="No email recipient — pass target_email in the body.",
        )
    if payload.via in ("sms", "both") and not target_phone:
        raise HTTPException(
            status_code=400,
            detail="No phone recipient — pass target_phone in the body.",
        )

    # Snapshot the target on the bill row so a follow-up resend
    # doesn't need it in the body. Also flip status back to pending
    # if the previous attempt failed; the Celery task will overwrite
    # on outcome.
    bill.delivery_email = target_email
    bill.delivery_phone = target_phone
    bill.delivery_status = "pending"
    bill.delivery_error = None
    await db.commit()

    # Late import so the Celery import graph doesn't drag the sync
    # engine into API-only code paths.
    from app.tasks.deliver_bill import deliver_bill

    deliver_bill.delay(
        str(bill.id),
        via=payload.via,
        target_email=target_email,
        target_phone=target_phone,
    )
    return {"status": "queued", "bill_id": str(bill.id)}
