"""QR-token inventory + resolution.

Two surfaces:

- **Public resolve** (`GET /qr/:token/resolve`) — no auth. The diner
  PWA hits this after a QR scan; the response is the (restaurant,
  table_code) pair the diner should be dropped into, or a
  `unassigned`/`retired` state the frontend can render honestly.

- **Admin inventory** (`/admin/platform/qr-tokens/*`) — behind the
  same `_require_admin` gate as the rest of the platform-owner
  backdoor. Generate a batch, list current inventory, bind one to a
  restaurant + table, retire a broken sticker.

Token format:
- 10 chars from a URL-safe alphabet without ambiguous glyphs (0/O,
  1/I/l dropped). Fits `plate-clean.app/qr/XXXXXXXXXX` inside a
  standard QR at a scanner-friendly module size (~29×29).
- Uniqueness enforced by DB — 10 chars from a 32-symbol alphabet
  gives ~1e15 possibilities, essentially collision-free for a
  pilot.
"""
from __future__ import annotations

import secrets
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.qr_token import QRToken
from app.models.restaurant import Restaurant
from app.models.user import User
from app.security import get_current_user

router = APIRouter()

# 32-symbol alphabet, no 0/O/1/I/l. Case-sensitive so the token is
# terse enough to fit a QR at moderate error correction. If we ever
# print with high enough ECC to eat the extra data budget we can
# drop to uppercase-only.
_TOKEN_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
_TOKEN_LEN = 10


def _mint_token() -> str:
    return "".join(secrets.choice(_TOKEN_ALPHABET) for _ in range(_TOKEN_LEN))


def _require_admin(user: User) -> None:
    """Same 404-not-403 hardening as the rest of the platform
    backdoor — a non-admin who guesses this URL can't confirm it
    exists."""
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


# ─────────── Schemas ───────────


TokenState = Literal["unassigned", "assigned", "retired"]


class QRTokenOut(BaseModel):
    id: UUID
    token: str
    batch_label: str | None = None
    state: TokenState
    restaurant_id: UUID | None = None
    restaurant_name: str | None = None
    restaurant_slug: str | None = None
    table_code: str | None = None
    assigned_at: datetime | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class GenerateBatchIn(BaseModel):
    count: int = Field(ge=1, le=500)
    batch_label: str | None = Field(default=None, max_length=64)


class BindTokenIn(BaseModel):
    restaurant_id: UUID
    table_code: str = Field(min_length=1, max_length=64)


class ResolveOut(BaseModel):
    """Public resolve response. Every field is optional because
    unassigned / retired tokens still return 200 (not 404) — the
    frontend then renders a friendly "not paired yet" screen rather
    than a hard error page."""

    token: str
    state: TokenState
    restaurant_id: UUID | None = None
    restaurant_name: str | None = None
    restaurant_slug: str | None = None
    table_code: str | None = None


# ─────────── Public resolve ───────────


@router.get("/qr/{token}/resolve", response_model=ResolveOut)
async def resolve_qr(
    token: str,
    db: AsyncSession = Depends(get_db),
) -> ResolveOut:
    """No auth. The diner PWA calls this after scanning a sticker.

    Behaviour:
      • Bound sticker → return restaurant + table so the client can
        create a session directly.
      • Unassigned sticker → state='unassigned', client shows a
        "This sticker isn't paired to a restaurant yet — check with
        staff" copy.
      • Retired sticker → same shape, state='retired'. Client shows
        a "This sticker was retired" message.
      • Unknown token → 404 (genuinely doesn't exist; different from
        the retired case).
    """
    res = await db.execute(select(QRToken).where(QRToken.token == token))
    row = res.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Token not found")
    restaurant: Restaurant | None = None
    if row.restaurant_id is not None:
        restaurant = await db.get(Restaurant, row.restaurant_id)
    return ResolveOut(
        token=row.token,
        state=row.state,  # type: ignore[arg-type]
        restaurant_id=row.restaurant_id,
        restaurant_name=restaurant.name if restaurant else None,
        restaurant_slug=restaurant.slug if restaurant else None,
        table_code=row.table_code,
    )


# ─────────── Admin: generate, list, bind, retire ───────────


@router.post(
    "/admin/platform/qr-tokens",
    response_model=list[QRTokenOut],
    status_code=status.HTTP_201_CREATED,
)
async def admin_generate_batch(
    payload: GenerateBatchIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[QRTokenOut]:
    """Mint N tokens in state='unassigned', tagged with an optional
    batch label. Returns the batch so the caller can immediately
    render them into a printable sheet (the CLI does this
    end-to-end; API-level callers can do it too).

    Collision handling: if the DB rejects a `token` unique-index
    insert (astronomically unlikely at 32^10), we retry that single
    row up to 5 times before failing the batch. In practice this
    branch never fires — it's here for correctness rather than
    concern.
    """
    _require_admin(user)
    made: list[QRToken] = []
    for _ in range(payload.count):
        for attempt in range(5):
            row = QRToken(
                token=_mint_token(),
                batch_label=payload.batch_label,
                state="unassigned",
            )
            db.add(row)
            try:
                await db.flush()
                made.append(row)
                break
            except IntegrityError:
                await db.rollback()
                if attempt == 4:
                    raise HTTPException(
                        status_code=500,
                        detail="Failed to mint a unique token after retries",
                    )
        else:  # pragma: no cover — flush should always succeed or raise
            continue
    await db.commit()
    for row in made:
        await db.refresh(row)
    return [QRTokenOut.model_validate(r) for r in made]


@router.get(
    "/admin/platform/qr-tokens", response_model=list[QRTokenOut]
)
async def admin_list_tokens(
    state_filter: TokenState | None = Query(default=None, alias="state"),
    batch: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[QRTokenOut]:
    _require_admin(user)
    q = select(QRToken)
    if state_filter:
        q = q.where(QRToken.state == state_filter)
    if batch:
        q = q.where(QRToken.batch_label == batch)
    q = q.order_by(QRToken.created_at.desc()).limit(1000)
    rows = list((await db.execute(q)).scalars().all())
    if not rows:
        return []
    restaurant_ids = {r.restaurant_id for r in rows if r.restaurant_id}
    restaurants: dict[UUID, Restaurant] = {}
    if restaurant_ids:
        rres = await db.execute(
            select(Restaurant).where(Restaurant.id.in_(restaurant_ids))
        )
        restaurants = {r.id: r for r in rres.scalars().all()}
    out: list[QRTokenOut] = []
    for r in rows:
        base = QRTokenOut.model_validate(r).model_dump()
        if r.restaurant_id and r.restaurant_id in restaurants:
            rr = restaurants[r.restaurant_id]
            base["restaurant_name"] = rr.name
            base["restaurant_slug"] = rr.slug
        out.append(QRTokenOut(**base))
    return out


@router.post(
    "/admin/platform/qr-tokens/{token}/bind",
    response_model=QRTokenOut,
)
async def admin_bind_token(
    token: str,
    payload: BindTokenIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> QRTokenOut:
    """Bind a physical sticker to a specific restaurant + table. The
    partial unique index in the migration prevents two active
    stickers from claiming the same seat — if you get an
    `ACTIVE_STICKER_EXISTS` error, retire the old one first."""
    _require_admin(user)
    res = await db.execute(select(QRToken).where(QRToken.token == token))
    row = res.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Token not found")
    if row.state == "retired":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "TOKEN_RETIRED",
                "message": "This token has been retired; print a fresh sticker instead.",
            },
        )
    restaurant = await db.get(Restaurant, payload.restaurant_id)
    if restaurant is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    row.restaurant_id = payload.restaurant_id
    row.table_code = payload.table_code.strip()
    row.state = "assigned"
    row.assigned_at = datetime.now(UTC)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "ACTIVE_STICKER_EXISTS",
                "message": (
                    "Another active sticker is already bound to that "
                    "restaurant/table. Retire it first."
                ),
            },
        ) from exc
    await db.refresh(row)
    return QRTokenOut(
        id=row.id,
        token=row.token,
        batch_label=row.batch_label,
        state=row.state,  # type: ignore[arg-type]
        restaurant_id=row.restaurant_id,
        restaurant_name=restaurant.name,
        restaurant_slug=restaurant.slug,
        table_code=row.table_code,
        assigned_at=row.assigned_at,
        created_at=row.created_at,
    )


@router.post(
    "/admin/platform/qr-tokens/{token}/retire",
    response_model=QRTokenOut,
)
async def admin_retire_token(
    token: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> QRTokenOut:
    """One-way state transition — retire is terminal. Once a sticker
    is retired the token is dead; a diner scanning it sees the
    "retired" copy and staff needs to bring a fresh sticker to that
    table."""
    _require_admin(user)
    res = await db.execute(select(QRToken).where(QRToken.token == token))
    row = res.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Token not found")
    row.state = "retired"
    await db.commit()
    await db.refresh(row)
    return QRTokenOut.model_validate(row)
