from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.session import get_db
from app.errors import (
    DuplicateCapture,
    GeofenceViolation,
    ImageInvalid,
    InvalidNonce,
    SessionExpired,
    WrongSessionStatus,
)
from app.models.bill import Bill
from app.models.consumption_score import ConsumptionScore
from app.models.dispute import Dispute
from app.models.meal_session import MealSession, MealSessionItem
from app.models.menu_item import MenuItem
from app.models.plate_capture import PlateCapture
from app.models.restaurant import Restaurant, RestaurantStaff
from app.models.reward import Reward, RewardRule
from app.models.user import User
from app.schemas.bill import BillGenerateIn, BillOut
from app.schemas.session import (
    CaptureOut,
    DisputeIn,
    DisputeOut,
    PerItemScoreOut,
    ScoreOut,
    SessionCancelIn,
    SessionCreateIn,
    SessionCreateOut,
    SessionDetailOut,
    SessionItemOut,
    SessionItemsIn,
    SessionItemsReplaceIn,
    SessionOut,
    WalkinSessionCreateIn,
    WalkinVoidIn,
)
from app.security import get_current_user, haversine_m
from app.services import billing, fraud, nonce, rate_limit, storage

router = APIRouter()
settings = get_settings()


@router.post("", response_model=SessionCreateOut, status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: SessionCreateIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionCreateOut:
    await rate_limit.check_sessions_per_day(user.id)

    restaurant = await db.get(Restaurant, payload.restaurant_id)
    if restaurant is None or not restaurant.is_active:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    now = datetime.now(UTC)
    session = MealSession(
        diner_user_id=user.id,
        restaurant_id=restaurant.id,
        table_code=payload.table_code,
        status="open",
        started_at=now,
        expires_at=now + timedelta(hours=settings.SESSION_TTL_HOURS),
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)

    before_nonce = await nonce.issue(session.id, "before", settings.NONCE_BEFORE_TTL_MINUTES)
    return SessionCreateOut(
        session_id=session.id,
        expires_at=session.expires_at,
        before_capture_nonce=before_nonce,
    )


@router.get("", response_model=list[dict])
async def list_my_sessions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Diner's own session inbox. Powers the "Sessions" screen on the
    diner PWA — the screen a returning diner lands on when they
    closed the tab mid-flow and need to pick up where they left off.

    Returns newest-first, capped at 50 rows. Each row is a compact
    summary — ID, restaurant name/slug, table code, status, timestamps,
    item count, and whether a bill / reward already exists. The client
    derives the "next action" (e.g. take before photo, capture after,
    view reward) from the status alone."""
    rows = await db.execute(
        select(MealSession, Restaurant)
        .join(Restaurant, Restaurant.id == MealSession.restaurant_id)
        .where(MealSession.diner_user_id == user.id)
        .order_by(MealSession.started_at.desc())
        .limit(50)
    )
    session_restaurant_pairs = list(rows.all())
    if not session_restaurant_pairs:
        return []

    session_ids = [s.id for s, _r in session_restaurant_pairs]

    # Item counts in a single query — avoids N+1 as the list grows.
    items_res = await db.execute(
        select(MealSessionItem.meal_session_id, MealSessionItem.quantity).where(
            MealSessionItem.meal_session_id.in_(session_ids)
        )
    )
    item_counts: dict[UUID, int] = {}
    for sid, qty in items_res.all():
        item_counts[sid] = item_counts.get(sid, 0) + int(qty)

    # Any bill / reward attached? Just booleans — the detail screen
    # already surfaces the full objects.
    bill_res = await db.execute(
        select(Bill.meal_session_id).where(Bill.meal_session_id.in_(session_ids))
    )
    has_bill = {sid for (sid,) in bill_res.all()}
    reward_res = await db.execute(
        select(Reward.meal_session_id).where(
            Reward.meal_session_id.in_(session_ids), Reward.voided_at.is_(None)
        )
    )
    has_reward = {sid for (sid,) in reward_res.all()}

    out: list[dict] = []
    for s, r in session_restaurant_pairs:
        out.append(
            {
                "id": str(s.id),
                "restaurant_id": str(s.restaurant_id),
                "restaurant_name": r.name,
                "restaurant_slug": r.slug,
                "table_code": s.table_code,
                "status": s.status,
                "started_at": s.started_at.isoformat(),
                "expires_at": s.expires_at.isoformat(),
                "cancelled_reason": s.cancelled_reason,
                "item_count": item_counts.get(s.id, 0),
                "has_bill": s.id in has_bill,
                "has_reward": s.id in has_reward,
            }
        )
    return out


@router.post("/{session_id}/items", response_model=SessionOut)
async def add_items(
    session_id: UUID,
    payload: SessionItemsIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionOut:
    session = await db.get(MealSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    # Auth split by channel:
    #   - QR session → must be the owning diner.
    #   - Walk-in    → must be staff of the owning restaurant (staff
    #     entered the order in the first place, so they also add to it
    #     from the drawer).
    if session.entry_channel == "walkin":
        await _require_staff_of_restaurant(db, user, session.restaurant_id)
    else:
        if session.diner_user_id != user.id:
            raise HTTPException(status_code=403, detail="Not your session")

    # Walk-ins live in 'open' or 'serving' before billing — allow items
    # to be added at both. QR sessions still gate on 'open'.
    allowed_statuses = {"open", "serving"} if session.entry_channel == "walkin" else {"open"}
    if session.status not in allowed_statuses:
        raise WrongSessionStatus(sorted(allowed_statuses), session.status)

    for item in payload.items:
        menu_item = await db.get(MenuItem, item.menu_item_id)
        if menu_item is None or menu_item.restaurant_id != session.restaurant_id:
            raise HTTPException(status_code=400, detail="Invalid menu_item_id")
        db.add(
            MealSessionItem(
                meal_session_id=session.id,
                menu_item_id=item.menu_item_id,
                quantity=item.quantity,
                portion_size=item.portion_size,
                notes=item.notes,
            )
        )
    await db.commit()
    await db.refresh(session)
    return SessionOut.model_validate(session)


@router.post(
    "/{session_id}/captures/before",
    response_model=CaptureOut,
    status_code=status.HTTP_201_CREATED,
)
async def capture_before(
    session_id: UUID,
    image: UploadFile = File(...),
    nonce_value: str = Form(..., alias="nonce"),
    client_lat: float | None = Form(default=None),
    client_lng: float | None = Form(default=None),
    device_fingerprint: str | None = Form(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CaptureOut:
    await rate_limit.check_captures_per_hour(user.id)
    session = await _load_session(db, session_id, owner_user_id=user.id)
    _ensure_session_alive(session)
    _reject_walkin_reward_path(session)
    if session.status != "open":
        raise WrongSessionStatus("open", session.status)

    if not await nonce.consume(session_id, "before", nonce_value):
        raise InvalidNonce()

    body = await image.read()
    mime, sha = storage.validate_and_hash(body)

    # Duplicate hash detection — fraud signal 5.
    existing = await db.execute(
        select(PlateCapture).where(PlateCapture.image_sha256 == sha)
    )
    if existing.first():
        await fraud.record(
            db,
            signal_type="duplicate_image_hash",
            severity="block",
            details={"sha256": sha},
            meal_session_id=session.id,
            user_id=user.id,
        )
        raise ImageInvalid("Image already submitted in another session")

    await _check_geofence(
        db, session=session, client_lat=client_lat, client_lng=client_lng, user_id=user.id
    )

    key = storage.upload_capture(session.id, "before", body, mime)
    capture = PlateCapture(
        meal_session_id=session.id,
        phase="before",
        image_s3_key=key,
        image_sha256=sha,
        captured_at=datetime.now(UTC),
        client_lat=client_lat,
        client_lng=client_lng,
        device_fingerprint=device_fingerprint,
        nonce=nonce_value,
    )
    db.add(capture)
    session.status = "before_captured"
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise DuplicateCapture() from exc
    await db.refresh(capture)

    after_nonce = await nonce.issue(session.id, "after", settings.NONCE_AFTER_TTL_MINUTES)
    return CaptureOut(
        capture_id=capture.id,
        image_s3_key=capture.image_s3_key,
        after_capture_nonce=after_nonce,
    )


@router.post(
    "/{session_id}/captures/after",
    response_model=CaptureOut,
    status_code=status.HTTP_201_CREATED,
)
async def capture_after(
    session_id: UUID,
    image: UploadFile = File(...),
    nonce_value: str = Form(..., alias="nonce"),
    client_lat: float | None = Form(default=None),
    client_lng: float | None = Form(default=None),
    device_fingerprint: str | None = Form(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CaptureOut:
    await rate_limit.check_captures_per_hour(user.id)
    session = await _load_session(db, session_id, owner_user_id=user.id)
    _ensure_session_alive(session)
    _reject_walkin_reward_path(session)
    if session.status not in ("before_captured", "eating"):
        raise WrongSessionStatus(["before_captured", "eating"], session.status)

    if not await nonce.consume(session_id, "after", nonce_value):
        raise InvalidNonce()

    before = await db.execute(
        select(PlateCapture).where(
            PlateCapture.meal_session_id == session.id, PlateCapture.phase == "before"
        )
    )
    before_cap = before.scalar_one_or_none()
    if before_cap is None:
        raise WrongSessionStatus("before_captured", session.status)

    now = datetime.now(UTC)
    delta = now - before_cap.captured_at
    if delta < timedelta(minutes=settings.MIN_MINUTES_BETWEEN_CAPTURES):
        await fraud.record(
            db,
            signal_type="time_between_captures_too_short",
            severity="warning",
            details={"seconds": int(delta.total_seconds())},
            meal_session_id=session.id,
            user_id=user.id,
        )
    if delta > timedelta(hours=settings.SESSION_TTL_HOURS):
        await fraud.record(
            db,
            signal_type="time_between_captures_too_short",
            severity="warning",
            details={"seconds": int(delta.total_seconds()), "reason": "exceeded_window"},
            meal_session_id=session.id,
            user_id=user.id,
        )

    body = await image.read()
    mime, sha = storage.validate_and_hash(body)

    existing = await db.execute(
        select(PlateCapture).where(PlateCapture.image_sha256 == sha)
    )
    if existing.first():
        await fraud.record(
            db,
            signal_type="duplicate_image_hash",
            severity="block",
            details={"sha256": sha},
            meal_session_id=session.id,
            user_id=user.id,
        )
        raise ImageInvalid("Image already submitted in another session")

    await _check_geofence(
        db, session=session, client_lat=client_lat, client_lng=client_lng, user_id=user.id
    )

    key = storage.upload_capture(session.id, "after", body, mime)
    capture = PlateCapture(
        meal_session_id=session.id,
        phase="after",
        image_s3_key=key,
        image_sha256=sha,
        captured_at=now,
        client_lat=client_lat,
        client_lng=client_lng,
        device_fingerprint=device_fingerprint,
        nonce=nonce_value,
    )
    db.add(capture)
    session.status = "after_submitted"
    session.client_lat = client_lat
    session.client_lng = client_lng
    session.device_fingerprint = device_fingerprint
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise DuplicateCapture() from exc
    await db.refresh(capture)

    # Enqueue scoring task (Celery). Imported here to avoid circular dependency at module load.
    from app.tasks.scoring import score_meal_session  # noqa: PLC0415

    score_meal_session.delay(str(session.id))

    return CaptureOut(
        capture_id=capture.id,
        image_s3_key=capture.image_s3_key,
        processing_status="queued",
    )


@router.get("/{session_id}", response_model=SessionDetailOut)
async def get_session(
    session_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionDetailOut:
    session = await _load_session(db, session_id, owner_user_id=user.id)
    items_result = await db.execute(
        select(MealSessionItem).where(MealSessionItem.meal_session_id == session.id)
    )
    items = [SessionItemOut.model_validate(i) for i in items_result.scalars().all()]

    caps_result = await db.execute(
        select(PlateCapture).where(PlateCapture.meal_session_id == session.id)
    )
    captures = [
        {"phase": c.phase, "captured_at": c.captured_at.isoformat()}
        for c in caps_result.scalars().all()
    ]

    score_result = await db.execute(
        select(ConsumptionScore).where(ConsumptionScore.meal_session_id == session.id)
    )
    score_model = score_result.scalar_one_or_none()
    score_out = _score_to_out(score_model) if score_model else None

    reward_result = await db.execute(
        select(Reward).where(Reward.meal_session_id == session.id)
    )
    reward = reward_result.scalar_one_or_none()
    reward_out: dict[str, object] | None = None
    if reward is not None:
        # Fetch the rule so the diner's RewardPanel can render the
        # choose-type sheet when the rule allows both `menu_item` and
        # `bill_discount`. Missing rule (deleted / bad seed) is soft-
        # failed — we just omit `allowed_reward_types` and the client
        # defaults to both.
        rule_result = await db.execute(
            select(RewardRule).where(RewardRule.id == reward.reward_rule_id)
        )
        rule = rule_result.scalar_one_or_none()
        now = datetime.now(UTC)
        if now >= reward.expires_at:
            current_value = 0
        elif now >= reward.half_value_at:
            current_value = reward.value_minor // 2
        else:
            current_value = reward.value_minor
        # Look up the issuing restaurant so the diner's RewardPanel
        # can render "Redeemable at <name>" — a diner with rewards
        # from multiple restaurants needs to know which coupon works
        # where.
        reward_restaurant = await db.get(Restaurant, session.restaurant_id)
        reward_out = {
            "id": str(reward.id),
            "redemption_code": reward.redemption_code,
            "reward_type": reward.reward_type,
            "value_minor": reward.value_minor,
            "current_value_minor": current_value,
            "issued_at": reward.issued_at.isoformat(),
            "half_value_at": reward.half_value_at.isoformat(),
            "expires_at": reward.expires_at.isoformat(),
            "redeemed_at": reward.redeemed_at.isoformat() if reward.redeemed_at else None,
            "redeemed_value_minor": reward.redeemed_value_minor,
            "voided_at": reward.voided_at.isoformat() if reward.voided_at else None,
            "voided_reason": reward.voided_reason,
            "restaurant_id": (
                str(reward_restaurant.id) if reward_restaurant else None
            ),
            "restaurant_name": (
                reward_restaurant.name if reward_restaurant else None
            ),
            "restaurant_slug": (
                reward_restaurant.slug if reward_restaurant else None
            ),
            "allowed_reward_types": list(rule.allowed_reward_types or [])
            if rule is not None
            else ["menu_item", "bill_discount"],
        }

    return SessionDetailOut(
        session=SessionOut.model_validate(session),
        items=items,
        captures=captures,
        score=score_out,
        reward=reward_out,
    )


@router.get("/{session_id}/score")
async def get_score(
    session_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await _load_session(db, session_id, owner_user_id=user.id)
    score_result = await db.execute(
        select(ConsumptionScore).where(ConsumptionScore.meal_session_id == session.id)
    )
    score_model = score_result.scalar_one_or_none()
    if score_model is None:
        # 202 Accepted: still processing.
        return {"status": "processing"}, status.HTTP_202_ACCEPTED

    reward_result = await db.execute(
        select(Reward).where(Reward.meal_session_id == session.id)
    )
    reward = reward_result.scalar_one_or_none()
    return {
        "score": _score_to_out(score_model).model_dump(),
        "session_status": session.status,
        "reward": (
            {
                "redemption_code": reward.redemption_code,
                "expires_at": reward.expires_at.isoformat(),
            }
            if reward
            else None
        ),
    }


def _bill_line_items_to_out(raw: list[dict[str, object]]) -> list[dict[str, object]]:
    """The JSONB payload we wrote at generation time is already the
    shape BillLineItemOut expects — but Pydantic won't coerce the
    `menu_item_id` string back to UUID for us in a plain dict. Just
    pass through; the schema at the endpoint boundary handles it."""
    return raw


def _bill_to_out(bill: Bill) -> dict[str, object]:
    return {
        "id": str(bill.id),
        "meal_session_id": str(bill.meal_session_id),
        "restaurant_id": str(bill.restaurant_id),
        "bill_number": bill.bill_number,
        "line_items": _bill_line_items_to_out(bill.line_items_json),
        "subtotal_minor": bill.subtotal_minor,
        "discount_minor": bill.discount_minor,
        "reward_redemption_code": bill.reward_redemption_code,
        "taxable_amount_minor": bill.taxable_amount_minor,
        "cgst_rate": str(bill.cgst_rate),
        "sgst_rate": str(bill.sgst_rate),
        "cgst_amount_minor": bill.cgst_amount_minor,
        "sgst_amount_minor": bill.sgst_amount_minor,
        "total_minor": bill.total_minor,
        "currency": bill.currency,
        "delivery_email": bill.delivery_email,
        "delivery_phone": bill.delivery_phone,
        "delivered_via": bill.delivered_via,
        "delivery_status": bill.delivery_status,
        "issued_at": bill.issued_at.isoformat(),
        "sent_at": bill.sent_at.isoformat() if bill.sent_at else None,
    }


async def _user_can_access_session_bill(
    db: AsyncSession, user: User, session: MealSession
) -> bool:
    """The bill's access set is: (a) the diner who owns the session,
    (b) any staff of the session's restaurant, (c) any admin.
    Return True/False rather than raise so callers can distinguish
    404 (session missing) from 403 (session exists but you don't own
    or staff it)."""
    if user.role == "admin":
        return True
    if session.diner_user_id == user.id:
        return True
    if user.role != "staff":
        return False
    res = await db.execute(
        select(RestaurantStaff).where(
            RestaurantStaff.user_id == user.id,
            RestaurantStaff.restaurant_id == session.restaurant_id,
        )
    )
    return res.scalar_one_or_none() is not None


@router.post("/{session_id}/bill", response_model=BillOut)
async def generate_bill(
    session_id: UUID,
    payload: BillGenerateIn | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    """Snapshot the session into a tax-invoice bill and return it.
    Idempotent — a second call returns the same bill unchanged; the
    optional `apply_redemption_code` on the payload is honoured only
    at the moment of first generation.

    Access: diner (own session), any restaurant staff, admin.
    """
    session = await db.get(MealSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if not await _user_can_access_session_bill(db, user, session):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not authorized to generate a bill for this session",
        )
    bill = await billing.get_or_create_bill(
        db,
        session_id=session.id,
        apply_redemption_code=payload.apply_redemption_code if payload else None,
        delivery_email=payload.delivery_email if payload else None,
        delivery_phone=payload.delivery_phone if payload else None,
    )
    return _bill_to_out(bill)


@router.get("/{session_id}/bill", response_model=BillOut)
async def get_bill(
    session_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    """Retrieve a previously-generated bill. 404 if none exists."""
    session = await db.get(MealSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if not await _user_can_access_session_bill(db, user, session):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not authorized to view this session's bill",
        )
    res = await db.execute(select(Bill).where(Bill.meal_session_id == session_id))
    bill = res.scalar_one_or_none()
    if bill is None:
        raise HTTPException(status_code=404, detail="No bill has been generated yet")
    return _bill_to_out(bill)


@router.post("/{session_id}/kitchen-ack")
async def kitchen_ack(
    session_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str | None]:
    """Kitchen taps "Mark sent" on the Orders dashboard. Cosmetic — the
    diner flow doesn't gate on this value; the button just moves the
    card from NEW ORDERS to PREPARING on the kanban.

    Idempotent: a second tap on an already-ack'd session is a no-op
    (returns the existing timestamp). Any restaurant staff can call —
    same policy as the Menu editor and Live Orders view.
    """
    session = await db.get(MealSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    # Auth: user must be staff of THIS session's restaurant, or admin.
    if user.role != "admin":
        if user.role != "staff":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only restaurant staff can acknowledge orders",
            )
        membership = await db.execute(
            select(RestaurantStaff).where(
                RestaurantStaff.user_id == user.id,
                RestaurantStaff.restaurant_id == session.restaurant_id,
            )
        )
        if membership.scalar_one_or_none() is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You are not on the staff of this restaurant",
            )
    if session.kitchen_ack_at is None:
        session.kitchen_ack_at = datetime.now(UTC)
        await db.commit()
        await db.refresh(session)
    return {
        "session_id": str(session.id),
        "kitchen_ack_at": session.kitchen_ack_at.isoformat(),
    }


async def _require_staff_of_restaurant(
    db: AsyncSession, user: User, restaurant_id: UUID
) -> None:
    """Raise 403 if the caller is not admin AND not on the staff of the
    given restaurant. Cancel + edit endpoints share the same policy so
    this is factored out from kitchen_ack."""
    if user.role == "admin":
        return
    if user.role != "staff":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only restaurant staff can perform this action",
        )
    membership = await db.execute(
        select(RestaurantStaff).where(
            RestaurantStaff.user_id == user.id,
            RestaurantStaff.restaurant_id == restaurant_id,
        )
    )
    if membership.scalar_one_or_none() is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not on the staff of this restaurant",
        )


@router.post("/{session_id}/cancel", response_model=SessionOut)
async def cancel_session(
    session_id: UUID,
    payload: SessionCancelIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionOut:
    """Staff cancels an in-flight order. Legal from any stage EXCEPT
    the terminal states — once a bill is issued or a reward is granted
    the money math has to stand.

    Ethics rule 9 (diner recourse): the reason is stored and shown to
    the diner on SessionStatus. We deliberately don't email the diner
    because their phone is already polling the session, and a duplicate
    channel would be noisy.

    If a bill exists for this session we refuse — cancelling after
    billing would break the immutable-invoice invariant. Staff can
    still refund out-of-band; the bill stands.
    """
    session = await db.get(MealSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    await _require_staff_of_restaurant(db, user, session.restaurant_id)

    # Refuse once the money-side has settled.
    if session.status in ("rewarded", "expired", "cancelled"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "SESSION_NOT_CANCELLABLE",
                "message": f"Session in terminal state '{session.status}' cannot be cancelled.",
            },
        )
    bill_res = await db.execute(
        select(Bill).where(Bill.meal_session_id == session.id)
    )
    if bill_res.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "BILL_ALREADY_ISSUED",
                "message": "This session already has an issued bill and cannot be cancelled.",
            },
        )

    now = datetime.now(UTC)
    session.status = "cancelled"
    session.cancelled_reason = payload.reason
    session.cancelled_at = now
    await db.commit()
    await db.refresh(session)
    return SessionOut.model_validate(session)


@router.patch("/{session_id}/items", response_model=SessionOut)
async def replace_session_items(
    session_id: UUID,
    payload: SessionItemsReplaceIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionOut:
    """Staff replaces the entire item list on a pre-bill session — the
    diner ordered wrong, or a dish is 86'd. Fails once a bill exists
    because rewriting items would silently change the bill total.

    Full-replace semantics rather than diff for simplicity: the client
    sends the new list, we DELETE all existing rows, INSERT the new
    ones. Kitchen might have already started cooking the old list,
    which is a real-world problem — the staff dashboard should warn
    them before firing this off. That warning lives in the frontend
    (see Orders.tsx edit modal in E2)."""
    session = await db.get(MealSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    await _require_staff_of_restaurant(db, user, session.restaurant_id)

    if session.status in ("rewarded", "expired", "cancelled"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "SESSION_NOT_EDITABLE",
                "message": f"Session in terminal state '{session.status}' cannot be edited.",
            },
        )
    bill_res = await db.execute(
        select(Bill).where(Bill.meal_session_id == session.id)
    )
    if bill_res.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "BILL_ALREADY_ISSUED",
                "message": "This session already has an issued bill; items are frozen.",
            },
        )

    # Validate every new item first so we don't half-apply.
    for item in payload.items:
        menu_item = await db.get(MenuItem, item.menu_item_id)
        if menu_item is None or menu_item.restaurant_id != session.restaurant_id:
            raise HTTPException(
                status_code=400, detail=f"Invalid menu_item_id: {item.menu_item_id}"
            )

    # Wipe the existing rows and insert the new list.
    existing_res = await db.execute(
        select(MealSessionItem).where(MealSessionItem.meal_session_id == session.id)
    )
    for row in existing_res.scalars().all():
        await db.delete(row)

    for item in payload.items:
        db.add(
            MealSessionItem(
                meal_session_id=session.id,
                menu_item_id=item.menu_item_id,
                quantity=item.quantity,
                portion_size=item.portion_size,
                notes=item.notes,
            )
        )
    await db.commit()
    await db.refresh(session)
    return SessionOut.model_validate(session)


@router.post(
    "/{session_id}/dispute", response_model=DisputeOut, status_code=status.HTTP_201_CREATED
)
async def file_dispute(
    session_id: UUID,
    payload: DisputeIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DisputeOut:
    session = await _load_session(db, session_id, owner_user_id=user.id)
    dispute = Dispute(
        meal_session_id=session.id,
        raised_by_user_id=user.id,
        reason=payload.reason,
        status="open",
    )
    db.add(dispute)
    session.status = "disputed"
    await db.commit()
    await db.refresh(dispute)

    # Fire off the support-team notification email async. Imported
    # inside the handler to avoid a circular import at module load
    # time — same pattern as the scoring task in capture_after. A
    # failure here is deliberately silent to the API caller: the
    # dispute is already durable in Postgres and visible on the
    # Disputes tab; the email is a courtesy heads-up.
    try:
        from app.tasks.deliver_dispute_email import deliver_dispute_email  # noqa: PLC0415

        deliver_dispute_email.delay(str(dispute.id))
    except Exception:  # noqa: BLE001 — never block the diner on this
        # We don't have structlog wired inline here; the enqueue
        # failure will surface in the celery-broker health checks.
        pass

    return DisputeOut(dispute_id=dispute.id)


# -- walk-in endpoints ------------------------------------------------------


@router.post(
    "/walkin",
    response_model=SessionOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_walkin_session(
    payload: WalkinSessionCreateIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionOut:
    """Staff-entered walk-in order — no diner account, no QR scan.

    Walk-ins bypass the entire reward machinery: no nonce is issued,
    no captures are allowed (the /captures/* endpoints reject
    entry_channel='walkin'), and no reward can be minted for the
    session even if a validation somehow reached it. The status
    machine is a simple linear track (open → serving → served →
    billed → paid) driven by staff actions.
    """
    await _require_staff_of_restaurant(db, user, payload.restaurant_id)
    restaurant = await db.get(Restaurant, payload.restaurant_id)
    if restaurant is None or not restaurant.is_active:
        raise HTTPException(status_code=404, detail="Restaurant not found")

    now = datetime.now(UTC)
    session = MealSession(
        diner_user_id=None,
        restaurant_id=restaurant.id,
        table_code=payload.table_code,
        status="open",
        entry_channel="walkin",
        started_at=now,
        expires_at=now + timedelta(hours=settings.SESSION_TTL_HOURS),
        customer_email=payload.customer_email,
        customer_phone=payload.customer_phone,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return SessionOut.model_validate(session)


# Statuses that indicate the money side has already settled — void is
# refused on these.
_WALKIN_VOID_TERMINAL = (
    "rewarded",
    "paid",
    "expired",
    "voided",
    "staff_rejected",
    "cancelled",
)


@router.post("/{session_id}/void", response_model=SessionOut)
async def void_session(
    session_id: UUID,
    payload: WalkinVoidIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionOut:
    """Void a session with a staff-supplied reason. Terminal — cannot
    be un-voided. Used from the drawer's "Void order" link on walk-in
    orders; the QR-side has its own /cancel endpoint with different
    semantics (diner recourse), so this stays walk-in-first but does
    not hard-refuse QR channel calls in case a staff needs the escape
    hatch.
    """
    session = await db.get(MealSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    await _require_staff_of_restaurant(db, user, session.restaurant_id)

    if session.status in _WALKIN_VOID_TERMINAL:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "SESSION_NOT_VOIDABLE",
                "message": f"Session in terminal state '{session.status}' cannot be voided.",
            },
        )

    now = datetime.now(UTC)
    session.status = "voided"
    session.voided_at = now
    session.voided_reason = payload.reason
    session.voided_by_user_id = user.id
    await db.commit()
    await db.refresh(session)
    return SessionOut.model_validate(session)


@router.post("/{session_id}/mark-paid", response_model=SessionOut)
async def mark_walkin_paid(
    session_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionOut:
    """Mark a walk-in order as paid. Idempotent same-state call is a
    no-op; anything else in a terminal state 409s. QR sessions have
    their own money path (rewards + bills) and cannot use this."""
    session = await db.get(MealSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    await _require_staff_of_restaurant(db, user, session.restaurant_id)

    if session.entry_channel != "walkin":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "WALKIN_ONLY",
                "message": "mark-paid is only valid for walk-in sessions.",
            },
        )
    if session.status == "paid":
        return SessionOut.model_validate(session)
    if session.status not in ("open", "serving", "served", "billed"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "WRONG_SESSION_STATUS",
                "message": f"Cannot mark paid from status '{session.status}'.",
            },
        )

    session.status = "paid"
    session.paid_at = datetime.now(UTC)
    await db.commit()
    await db.refresh(session)
    return SessionOut.model_validate(session)


# -- helpers ----------------------------------------------------------------


def _reject_walkin_reward_path(session: MealSession) -> None:
    """Raise a structured 400 if the caller is trying to run a reward-path
    action (capture, validation, reward-issue) on a walk-in session.
    Walk-ins are billed only; they cannot earn rewards."""
    if session.entry_channel == "walkin":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "WALKIN_NOT_REWARD_ELIGIBLE",
                "message": "Walk-in orders cannot receive rewards.",
            },
        )


async def _load_session(
    db: AsyncSession, session_id: UUID, owner_user_id: UUID | None = None
) -> MealSession:
    session = await db.get(MealSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if owner_user_id is not None and session.diner_user_id != owner_user_id:
        raise HTTPException(status_code=403, detail="Not your session")
    return session


def _ensure_session_alive(session: MealSession) -> None:
    if session.expires_at < datetime.now(UTC):
        raise SessionExpired()


async def _check_geofence(
    db: AsyncSession,
    *,
    session: MealSession,
    client_lat: float | None,
    client_lng: float | None,
    user_id: UUID,
) -> None:
    if client_lat is None or client_lng is None:
        return
    restaurant = await db.get(Restaurant, session.restaurant_id)
    if restaurant is None:
        return
    distance_m = haversine_m(client_lat, client_lng, restaurant.latitude, restaurant.longitude)
    if distance_m > restaurant.geofence_radius_m:
        await fraud.record(
            db,
            signal_type="geofence_violation",
            severity="warning" if settings.GEOFENCE_MODE == "warn" else "block",
            details={"distance_m": distance_m, "max_m": restaurant.geofence_radius_m},
            meal_session_id=session.id,
            user_id=user_id,
        )
        if settings.GEOFENCE_MODE == "block":
            raise GeofenceViolation(distance_m=distance_m, max_m=restaurant.geofence_radius_m)


def _score_to_out(s: ConsumptionScore) -> ScoreOut:
    return ScoreOut(
        overall_score=float(s.overall_score),
        per_item_scores=[PerItemScoreOut(**pi) for pi in (s.per_item_scores or [])],
        model_name=s.model_name,
        model_version=s.model_version,
        processing_ms=s.processing_ms,
        suspicious=bool(s.suspicious),
        confidence=float(s.confidence) if s.confidence is not None else None,
        notes=s.notes,
    )
