"""Self-serve dining-table registry per restaurant.

Restaurant owners and managers manage their dining tables from the
dashboard's Settings → Tables screen. Adding a table optionally mints
a fresh `qr_tokens` row bound to it in one step, so a new table is
ready to print and stick without a platform-admin round-trip.

Servers can't touch this surface — the sprint kickoff carved out
table administration (and, later, price editing) as owner-or-manager
concerns even though the wider staff-editing decision opened menu
CRUD to servers. Grep for callers of `_require_owner_or_manager`
before widening.

Every code_ conflict, cross-restaurant call, and non-staff caller
returns the errors-module envelope shape (see task_e990fddf).
"""
from __future__ import annotations

import re
import secrets
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.errors import ApiError, NotRestaurantStaff
from app.models.qr_token import QRToken
from app.models.restaurant import Restaurant, RestaurantStaff
from app.models.restaurant_table import RestaurantTable
from app.models.user import User
from app.security import get_current_user

router = APIRouter()


# Token minting mirrors qr_tokens.py exactly — same alphabet, same
# length — so a self-serve token is indistinguishable from a batch
# token in the field. Kept as constants here rather than imported so
# a future divergence (e.g. shorter self-serve codes) is a local edit.
_TOKEN_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
_TOKEN_LEN = 10

_TABLE_CODE_RE = re.compile(r"^T-(\d{2,4})$")


def _mint_token() -> str:
    return "".join(secrets.choice(_TOKEN_ALPHABET) for _ in range(_TOKEN_LEN))


class TableCodeExists(ApiError):
    def __init__(self, table_code: str) -> None:
        super().__init__(
            status_code=status.HTTP_409_CONFLICT,
            code="TABLE_CODE_EXISTS",
            message=f"An active table already uses code '{table_code}'.",
            details={"table_code": table_code},
        )


async def _require_owner_or_manager(
    db: AsyncSession, user: User, restaurant_id: UUID
) -> None:
    """Table admin sits with owner/manager per product decision; a
    server touching this router gets NOT_RESTAURANT_STAFF (same 403
    envelope as task_e990fddf). Admins bypass unconditionally.
    """
    if user.role == "admin":
        return
    if user.role != "staff":
        raise NotRestaurantStaff()
    res = await db.execute(
        select(RestaurantStaff).where(
            RestaurantStaff.user_id == user.id,
            RestaurantStaff.restaurant_id == restaurant_id,
        )
    )
    link = res.scalar_one_or_none()
    if link is None or link.role not in ("owner", "manager"):
        raise NotRestaurantStaff()


# ─────────── Schemas ───────────


TokenState = Literal["unassigned", "assigned", "retired"]


class QRTokenLite(BaseModel):
    id: UUID
    token: str
    state: TokenState


class RestaurantTableOut(BaseModel):
    id: UUID
    table_code: str
    seat_count: int
    is_active: bool
    display_order: int
    notes: str | None = None
    qr_token: QRTokenLite | None = None


class CreateTableIn(BaseModel):
    table_code: str | None = Field(default=None, min_length=1, max_length=64)
    seat_count: int = Field(default=4, ge=1, le=20)
    auto_generate_qr: bool = True
    notes: str | None = Field(default=None, max_length=500)


class PatchTableIn(BaseModel):
    table_code: str | None = Field(default=None, min_length=1, max_length=64)
    seat_count: int | None = Field(default=None, ge=1, le=20)
    notes: str | None = Field(default=None, max_length=500)
    display_order: int | None = Field(default=None, ge=0)
    is_active: bool | None = None  # accepts True to restore a soft-deleted row


# ─────────── Helpers ───────────


async def _load_table(
    db: AsyncSession, restaurant_id: UUID, table_id: UUID
) -> RestaurantTable:
    row = await db.get(RestaurantTable, table_id)
    if row is None or row.restaurant_id != restaurant_id:
        raise HTTPException(status_code=404, detail="Table not found")
    return row


def _serialize(row: RestaurantTable, token: QRToken | None) -> RestaurantTableOut:
    return RestaurantTableOut(
        id=row.id,
        table_code=row.table_code,
        seat_count=row.seat_count,
        is_active=row.is_active,
        display_order=row.display_order,
        notes=row.notes,
        qr_token=(
            QRTokenLite(id=token.id, token=token.token, state=token.state)  # type: ignore[arg-type]
            if token is not None
            else None
        ),
    )


async def _fetch_token(db: AsyncSession, token_id: UUID | None) -> QRToken | None:
    if token_id is None:
        return None
    return await db.get(QRToken, token_id)


async def _next_sequential_code(db: AsyncSession, restaurant_id: UUID) -> str:
    """Compute T-{N+1:02d} where N is the highest T-NN across active
    rows for this restaurant. Ignores non-numeric codes so a custom
    label like "PATIO-A" doesn't perturb the sequence."""
    res = await db.execute(
        select(RestaurantTable.table_code).where(
            RestaurantTable.restaurant_id == restaurant_id,
            RestaurantTable.is_active.is_(True),
        )
    )
    highest = 0
    for (code,) in res.all():
        m = _TABLE_CODE_RE.match(code)
        if m:
            n = int(m.group(1))
            if n > highest:
                highest = n
    return f"T-{highest + 1:02d}"


async def _max_display_order(db: AsyncSession, restaurant_id: UUID) -> int:
    res = await db.execute(
        select(func.coalesce(func.max(RestaurantTable.display_order), 0)).where(
            RestaurantTable.restaurant_id == restaurant_id,
            RestaurantTable.is_active.is_(True),
        )
    )
    return int(res.scalar_one())


async def _mint_bound_token(
    db: AsyncSession, restaurant_id: UUID, table_code: str
) -> QRToken:
    """Create a fresh qr_tokens row in state='assigned' for this
    (restaurant, table_code). Retries on the ludicrously unlikely
    token-uniqueness clash. Matches qr_tokens.py's admin_generate_batch
    retry budget."""
    for attempt in range(5):
        row = QRToken(
            token=_mint_token(),
            batch_label="self-serve",
            state="assigned",
            restaurant_id=restaurant_id,
            table_code=table_code,
            assigned_at=datetime.now(UTC),
        )
        db.add(row)
        try:
            await db.flush()
            return row
        except IntegrityError:
            await db.rollback()
            if attempt == 4:
                raise HTTPException(
                    status_code=500,
                    detail="Failed to mint a unique token after retries",
                )
    raise HTTPException(status_code=500, detail="Failed to mint token")  # pragma: no cover


async def _retire_bound_token(db: AsyncSession, token_id: UUID | None) -> None:
    """Retire the qr_tokens row (if any) currently bound to a table.
    Clears its restaurant+table binding so the partial unique index
    frees up for a replacement."""
    if token_id is None:
        return
    token = await db.get(QRToken, token_id)
    if token is None:
        return
    token.state = "retired"
    token.table_code = None
    token.restaurant_id = None


# ─────────── Endpoints ───────────


@router.get(
    "/{restaurant_id}/tables",
    response_model=list[RestaurantTableOut],
)
async def list_tables(
    restaurant_id: UUID,
    include_inactive: bool = Query(default=False),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[RestaurantTableOut]:
    await _require_owner_or_manager(db, user, restaurant_id)
    q = select(RestaurantTable).where(RestaurantTable.restaurant_id == restaurant_id)
    if not include_inactive:
        q = q.where(RestaurantTable.is_active.is_(True))
    q = q.order_by(RestaurantTable.display_order.asc(), RestaurantTable.table_code.asc())
    rows = list((await db.execute(q)).scalars().all())
    token_ids = {r.qr_token_id for r in rows if r.qr_token_id}
    tokens: dict[UUID, QRToken] = {}
    if token_ids:
        tres = await db.execute(select(QRToken).where(QRToken.id.in_(token_ids)))
        tokens = {t.id: t for t in tres.scalars().all()}
    return [_serialize(r, tokens.get(r.qr_token_id) if r.qr_token_id else None) for r in rows]


@router.post(
    "/{restaurant_id}/tables",
    response_model=RestaurantTableOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_table(
    restaurant_id: UUID,
    payload: CreateTableIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RestaurantTableOut:
    await _require_owner_or_manager(db, user, restaurant_id)
    if (await db.get(Restaurant, restaurant_id)) is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    table_code = payload.table_code.strip() if payload.table_code else None
    if table_code is None:
        table_code = await _next_sequential_code(db, restaurant_id)
    else:
        existing = await db.execute(
            select(RestaurantTable).where(
                RestaurantTable.restaurant_id == restaurant_id,
                RestaurantTable.table_code == table_code,
                RestaurantTable.is_active.is_(True),
            )
        )
        if existing.scalar_one_or_none() is not None:
            raise TableCodeExists(table_code)

    next_order = (await _max_display_order(db, restaurant_id)) + 1

    row = RestaurantTable(
        restaurant_id=restaurant_id,
        table_code=table_code,
        seat_count=payload.seat_count,
        is_active=True,
        display_order=next_order,
        notes=payload.notes,
    )
    db.add(row)
    await db.flush()

    token: QRToken | None = None
    if payload.auto_generate_qr:
        token = await _mint_bound_token(db, restaurant_id, table_code)
        row.qr_token_id = token.id

    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        # Race on the partial unique index (two concurrent adds of the
        # same code). Surface the same envelope.
        raise TableCodeExists(table_code) from exc

    await db.refresh(row)
    if token is not None:
        await db.refresh(token)
    return _serialize(row, token)


@router.patch(
    "/{restaurant_id}/tables/{table_id}",
    response_model=RestaurantTableOut,
)
async def patch_table(
    restaurant_id: UUID,
    table_id: UUID,
    payload: PatchTableIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RestaurantTableOut:
    await _require_owner_or_manager(db, user, restaurant_id)
    row = await _load_table(db, restaurant_id, table_id)
    data = payload.model_dump(exclude_unset=True)

    if "seat_count" in data and data["seat_count"] is not None:
        row.seat_count = data["seat_count"]
    if "notes" in data:
        row.notes = data["notes"]
    if "display_order" in data and data["display_order"] is not None:
        row.display_order = data["display_order"]

    if "is_active" in data and data["is_active"] is not None:
        want_active = bool(data["is_active"])
        if want_active and not row.is_active:
            # Restore: make sure the code doesn't collide with an
            # active row that took over the same label in the meantime.
            clash = await db.execute(
                select(RestaurantTable).where(
                    RestaurantTable.restaurant_id == restaurant_id,
                    RestaurantTable.table_code == row.table_code,
                    RestaurantTable.is_active.is_(True),
                    RestaurantTable.id != row.id,
                )
            )
            if clash.scalar_one_or_none() is not None:
                raise TableCodeExists(row.table_code)
            row.is_active = True
        elif not want_active and row.is_active:
            row.is_active = False
            await _retire_bound_token(db, row.qr_token_id)
            row.qr_token_id = None

    if "table_code" in data and data["table_code"] is not None:
        new_code = data["table_code"].strip()
        if new_code != row.table_code:
            clash = await db.execute(
                select(RestaurantTable).where(
                    RestaurantTable.restaurant_id == restaurant_id,
                    RestaurantTable.table_code == new_code,
                    RestaurantTable.is_active.is_(True),
                    RestaurantTable.id != row.id,
                )
            )
            if clash.scalar_one_or_none() is not None:
                raise TableCodeExists(new_code)
            # Printed tokens are immutable in the field — retire the
            # old binding and null the pointer. Owner then generates a
            # fresh one for the new code.
            await _retire_bound_token(db, row.qr_token_id)
            row.qr_token_id = None
            row.table_code = new_code

    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise TableCodeExists(row.table_code) from exc
    await db.refresh(row)
    token = await _fetch_token(db, row.qr_token_id)
    return _serialize(row, token)


@router.delete(
    "/{restaurant_id}/tables/{table_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def soft_delete_table(
    restaurant_id: UUID,
    table_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    await _require_owner_or_manager(db, user, restaurant_id)
    row = await _load_table(db, restaurant_id, table_id)
    if row.is_active:
        row.is_active = False
        await _retire_bound_token(db, row.qr_token_id)
        row.qr_token_id = None
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{restaurant_id}/tables/{table_id}/regenerate-qr",
    response_model=RestaurantTableOut,
)
async def regenerate_table_qr(
    restaurant_id: UUID,
    table_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RestaurantTableOut:
    """Retire the current bound token (if any) and mint a fresh one.
    Used when a printed sticker is damaged or lost."""
    await _require_owner_or_manager(db, user, restaurant_id)
    row = await _load_table(db, restaurant_id, table_id)
    if not row.is_active:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "TABLE_INACTIVE",
                "message": "Restore the table before regenerating its QR.",
            },
        )
    await _retire_bound_token(db, row.qr_token_id)
    row.qr_token_id = None
    token = await _mint_bound_token(db, restaurant_id, row.table_code)
    row.qr_token_id = token.id
    await db.commit()
    await db.refresh(row)
    await db.refresh(token)
    return _serialize(row, token)
