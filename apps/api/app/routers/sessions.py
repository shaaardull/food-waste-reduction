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
from app.models.consumption_score import ConsumptionScore
from app.models.dispute import Dispute
from app.models.meal_session import MealSession, MealSessionItem
from app.models.menu_item import MenuItem
from app.models.plate_capture import PlateCapture
from app.models.restaurant import Restaurant
from app.models.reward import Reward
from app.models.user import User
from app.schemas.session import (
    CaptureOut,
    DisputeIn,
    DisputeOut,
    PerItemScoreOut,
    ScoreOut,
    SessionCreateIn,
    SessionCreateOut,
    SessionDetailOut,
    SessionItemOut,
    SessionItemsIn,
    SessionOut,
)
from app.security import get_current_user, haversine_m
from app.services import fraud, nonce, rate_limit, storage

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


@router.post("/{session_id}/items", response_model=SessionOut)
async def add_items(
    session_id: UUID,
    payload: SessionItemsIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionOut:
    session = await _load_session(db, session_id, owner_user_id=user.id)
    if session.status != "open":
        raise WrongSessionStatus("open", session.status)

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
    reward_out = (
        {
            "id": str(reward.id),
            "redemption_code": reward.redemption_code,
            "expires_at": reward.expires_at.isoformat(),
            "redeemed_at": reward.redeemed_at.isoformat() if reward.redeemed_at else None,
        }
        if reward
        else None
    )

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
    return DisputeOut(dispute_id=dispute.id)


# -- helpers ----------------------------------------------------------------


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
