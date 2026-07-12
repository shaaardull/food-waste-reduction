"""Bill generation — the money math for Gap-D.

Public surface is `get_or_create_bill(db, session_id, ...)`. Everything
else is a private helper.

Design principles:
- All math in paise (int) — no floats anywhere in the money path.
- GST rates snapshot at issue time via `bills.cgst_rate` / `sgst_rate`
  so a later restaurant.gst_rate change doesn't retroactively rewrite
  a past bill.
- Line items snapshot as JSONB so a menu edit / soft-delete after the
  bill was issued doesn't leave the bill referencing a gone name.
- Idempotent by construction: `bills.meal_session_id` is UNIQUE, so a
  second `get_or_create_bill` for the same session returns the existing
  row without creating a duplicate.
- Bill numbers are `<prefix><YYYY>/<5-digit-seq>` per restaurant per
  calendar year. Concurrent inserts race for the same sequence; the
  UNIQUE(restaurant_id, bill_number) catches it and we retry once with
  the next number.

CGST + SGST rounding: computed via `round_half_up` (banker's rounding
would surprise a diner). Split is `gst_rate / 2` each on the taxable
amount, then rounded independently. Sum-of-rounded-parts is what the
diner pays; over/undershoot vs the exact rate is at most 1 paisa.
"""
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.bill import Bill
from app.models.meal_session import MealSession, MealSessionItem
from app.models.menu_item import MenuItem
from app.models.restaurant import Restaurant
from app.models.reward import Reward


class BillGenerationError(HTTPException):
    """Business-rule violation during generation — surfaced with a
    stable code the frontend can switch on for i18n copy."""

    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(
            status_code=status_code,
            detail={"code": code, "message": message},
        )


def _round_paise(amount: Decimal) -> int:
    """Round to the nearest paisa, half-up. Explicit ROUND_HALF_UP so
    the diner doesn't see a 49-paise line become 0 while a 51-paise
    line becomes 1 — banker's rounding is technically fairer but
    confuses receipts."""
    return int(amount.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


async def _next_bill_number(
    db: AsyncSession, restaurant: Restaurant, at: datetime
) -> str:
    """Compute the next per-restaurant sequence for the given year.
    Callers should retry on IntegrityError — under concurrent inserts
    two callers can both read the same seq before either commits."""
    year = at.year
    seq_res = await db.execute(
        select(func.count(Bill.id)).where(
            Bill.restaurant_id == restaurant.id,
            func.extract("year", Bill.issued_at) == year,
        )
    )
    seq = (seq_res.scalar_one() or 0) + 1
    prefix = restaurant.bill_prefix or ""
    return f"{prefix}{year}/{seq:05d}"


async def _load_line_items(
    db: AsyncSession, session_id: UUID
) -> tuple[list[dict[str, Any]], int]:
    """Return (frozen_line_items, subtotal_minor).

    Frozen shape matches BillLineItemOut so the JSONB round-trips
    directly into the response without a second dump pass. Even if
    the menu item was soft-deleted since the order, the join still
    resolves because soft-delete only flips is_active."""
    rows = await db.execute(
        select(MealSessionItem, MenuItem)
        .join(MenuItem, MealSessionItem.menu_item_id == MenuItem.id)
        .where(MealSessionItem.meal_session_id == session_id)
    )
    line_items: list[dict[str, Any]] = []
    subtotal = 0
    for msi, menu in rows.all():
        line_total = msi.quantity * menu.price_minor
        subtotal += line_total
        line_items.append(
            {
                "menu_item_id": str(menu.id),
                "name": menu.name,
                "quantity": msi.quantity,
                "portion_size": msi.portion_size,
                "price_minor": menu.price_minor,
                "line_total_minor": line_total,
            }
        )
    return line_items, subtotal


async def _resolve_reward_discount(
    db: AsyncSession,
    *,
    session: MealSession,
    redemption_code: str | None,
) -> tuple[int, str | None]:
    """Return (discount_minor, redemption_code_used).

    Only `bill_discount` rewards translate into a real subtraction on
    the current bill. A `menu_item` reward is a free dish on a future
    visit — it doesn't reduce THIS bill (the current visit isn't
    consuming that reward).

    Rules the redemption code must satisfy:
      - exists
      - belongs to the same restaurant as the session
      - reward_type = 'bill_discount' (menu_item can't discount cash)
      - not voided
      - not expired
      - not already redeemed (2nd tap on redeem does not double-apply)

    Any violation raises a BillGenerationError with a stable code the
    frontend can switch on for a good i18n message.
    """
    if not redemption_code:
        return 0, None
    reward_res = await db.execute(
        select(Reward).where(Reward.redemption_code == redemption_code)
    )
    reward = reward_res.scalar_one_or_none()
    if reward is None:
        raise BillGenerationError(
            "REWARD_NOT_FOUND", "Reward code not found."
        )
    # Ownership check via the session the reward was issued for — that
    # session's restaurant must match the current bill's restaurant.
    reward_session = await db.get(MealSession, reward.meal_session_id)
    if reward_session is None or reward_session.restaurant_id != session.restaurant_id:
        raise BillGenerationError(
            "REWARD_WRONG_RESTAURANT",
            "That reward was issued at a different restaurant.",
        )
    # Self-discount block: a reward issued IN this session cannot be
    # applied TO this session's own bill. Rewards are a return-visit
    # incentive — otherwise the diner effectively pre-discounts the
    # meal they're being rewarded for, which unwinds the point of
    # the loop. The reward can still be spent on a FUTURE bill at
    # the same restaurant.
    if reward.meal_session_id == session.id:
        raise BillGenerationError(
            "REWARD_SAME_SESSION",
            (
                "This reward was earned in this same meal — save it for your "
                "next visit to this restaurant. Rewards can't discount the "
                "bill of the meal that earned them."
            ),
        )
    if reward.reward_type != "bill_discount":
        raise BillGenerationError(
            "REWARD_NOT_BILL_DISCOUNT",
            "Only bill-discount rewards can be applied to a bill.",
        )
    if reward.voided_at is not None:
        raise BillGenerationError("REWARD_VOIDED", "That reward was voided.")
    if reward.redeemed_at is not None:
        raise BillGenerationError(
            "REWARD_ALREADY_REDEEMED", "That reward was already redeemed."
        )
    now = datetime.now(UTC)
    if now >= reward.expires_at:
        raise BillGenerationError("REWARD_EXPIRED", "That reward has expired.")
    # Half-value window per §12: after `half_value_at`, the reward is
    # worth 50% of `value_minor`. The `current_value_minor` field is
    # computed dynamically at read time; we recompute here to avoid a
    # trust-the-client bug.
    if now >= reward.half_value_at:
        discount = reward.value_minor // 2
    else:
        discount = reward.value_minor
    return discount, reward.redemption_code


async def get_or_create_bill(
    db: AsyncSession,
    *,
    session_id: UUID,
    apply_redemption_code: str | None = None,
    delivery_email: str | None = None,
    delivery_phone: str | None = None,
) -> Bill:
    """Public entrypoint. Returns the existing bill row if one already
    exists for this session (idempotent — a second call with a
    different redemption code does NOT re-price the existing bill;
    that would break the immutable-invoice invariant).

    Raises:
      HTTPException(404) if the session doesn't exist.
      BillGenerationError('NO_ITEMS', ...) if the session has no items.
      BillGenerationError('REWARD_*', ...) if the reward code is bad.
    """
    session = await db.get(MealSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    # Idempotency: return the existing row if we already generated one.
    existing_res = await db.execute(
        select(Bill).where(Bill.meal_session_id == session.id)
    )
    existing = existing_res.scalar_one_or_none()
    if existing is not None:
        return existing

    restaurant = await db.get(Restaurant, session.restaurant_id)
    if restaurant is None:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    line_items, subtotal = await _load_line_items(db, session.id)
    if not line_items:
        raise BillGenerationError(
            "NO_ITEMS",
            "This session has no ordered items — nothing to bill.",
        )

    discount, code_used = await _resolve_reward_discount(
        db, session=session, redemption_code=apply_redemption_code
    )
    # Discount capped at subtotal — a reward worth more than the meal
    # doesn't leave the diner owing negative tax.
    discount = min(discount, subtotal)
    taxable = subtotal - discount

    # Split the restaurant's flat GST rate 50/50 into CGST + SGST for
    # intra-state supply (Mumbai pilot is intra-state). If we ever add
    # inter-state (IGST), a `restaurant.gst_kind` column would flag it
    # and this function would output a single igst_amount instead.
    #
    # Sprint E toggle: when gst_enabled is false the restaurant is
    # below the ₹20L threshold (or on a composition scheme); we snapshot
    # zero rates so the bill still round-trips cleanly through the same
    # columns but the diner isn't charged GST.
    if restaurant.gst_enabled:
        half_rate = restaurant.gst_rate / Decimal(2)
        cgst_amount = _round_paise(Decimal(taxable) * half_rate)
        sgst_amount = _round_paise(Decimal(taxable) * half_rate)
    else:
        half_rate = Decimal("0.000")
        cgst_amount = 0
        sgst_amount = 0
    total = taxable + cgst_amount + sgst_amount

    issued_at = datetime.now(UTC)

    # Retry loop for the bill_number race — the sequence is computed
    # from a COUNT that another concurrent txn might already have used.
    # Try 3 times before giving up (real pilot load is single-digit
    # bills/min, so this basically never fires).
    for attempt in range(3):
        try:
            bill_number = await _next_bill_number(db, restaurant, issued_at)
            bill = Bill(
                meal_session_id=session.id,
                restaurant_id=restaurant.id,
                bill_number=bill_number,
                subtotal_minor=subtotal,
                discount_minor=discount,
                reward_redemption_code=code_used,
                taxable_amount_minor=taxable,
                cgst_rate=half_rate,
                sgst_rate=half_rate,
                cgst_amount_minor=cgst_amount,
                sgst_amount_minor=sgst_amount,
                total_minor=total,
                currency=restaurant.currency,
                line_items_json=line_items,
                delivery_email=delivery_email,
                delivery_phone=delivery_phone,
                delivery_status="pending",
                issued_at=issued_at,
            )
            db.add(bill)
            await db.commit()
            await db.refresh(bill)
            return bill
        except IntegrityError:
            # Two callers picked the same seq; roll back and try again.
            await db.rollback()
            if attempt == 2:
                # Extremely unlikely — either persistent seq race
                # (impossible at pilot scale) or the meal_session_id
                # UNIQUE fired because another concurrent caller beat
                # us to the same bill. Re-read the existing row.
                retry = await db.execute(
                    select(Bill).where(Bill.meal_session_id == session.id)
                )
                lost = retry.scalar_one_or_none()
                if lost is not None:
                    return lost
                raise
    # Unreachable — the loop above either returns or re-raises.
    raise RuntimeError("bill generation loop exhausted without terminal state")
