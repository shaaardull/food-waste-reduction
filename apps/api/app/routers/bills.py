"""Bill lookup by bill_id.

Session-scoped generation + retrieval live on the sessions router
(POST/GET /sessions/:id/bill). This module adds a direct `/bills/:id`
GET for cases where the caller already has the bill_id — the email
delivery link, or the staff dashboard's bill history — and doesn't
want to round-trip through the session id.
"""
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.bill import Bill
from app.models.meal_session import MealSession
from app.models.user import User
from app.routers.sessions import _bill_to_out, _user_can_access_session_bill
from app.schemas.bill import BillOut
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
