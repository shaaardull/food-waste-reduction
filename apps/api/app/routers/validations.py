from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.session import get_db
from app.errors import (
    NotRestaurantStaff,
    ValidationAlreadyDecided,
    ValidationRequiresFinalScore,
    ValidationRequiresReasonCode,
    WrongSessionStatus,
)
from app.models.consumption_score import ConsumptionScore
from app.models.fraud_signal import FraudSignal
from app.models.meal_session import MealSession, MealSessionItem
from app.models.menu_item import MenuItem
from app.models.plate_capture import PlateCapture
from app.models.restaurant import Restaurant, RestaurantStaff
from app.models.reward import Reward, RewardRule
from app.models.staff_validation import StaffValidation
from app.models.user import User
from app.schemas.validation import (
    EscalateIn,
    PendingValidationOut,
    ValidationIn,
)
from app.security import get_current_user, new_redemption_code
from app.services import rate_limit, sms, storage

router = APIRouter()
settings = get_settings()


async def _require_staff_at(
    db: AsyncSession, user: User, restaurant_id: UUID
) -> RestaurantStaff:
    if user.role not in ("staff", "admin"):
        raise NotRestaurantStaff()
    result = await db.execute(
        select(RestaurantStaff).where(
            RestaurantStaff.user_id == user.id,
            RestaurantStaff.restaurant_id == restaurant_id,
        )
    )
    rs = result.scalar_one_or_none()
    if rs is None and user.role != "admin":
        raise NotRestaurantStaff()
    return rs  # type: ignore[return-value]


@router.get(
    "/restaurants/{restaurant_id}/validations/pending",
    response_model=list[PendingValidationOut],
)
async def list_pending(
    restaurant_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=50, ge=1, le=200),
) -> list[PendingValidationOut]:
    await _require_staff_at(db, user, restaurant_id)
    result = await db.execute(
        select(MealSession)
        .where(
            MealSession.restaurant_id == restaurant_id,
            MealSession.status == "pending_staff_validation",
        )
        .order_by(MealSession.updated_at.asc())
        .limit(limit)
    )
    sessions = list(result.scalars().all())
    out: list[PendingValidationOut] = []
    for s in sessions:
        out.append(await _build_pending(db, s))
    return out


@router.get(
    "/sessions/{session_id}/validation-bundle",
    response_model=PendingValidationOut,
)
async def validation_bundle(
    session_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PendingValidationOut:
    session = await db.get(MealSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    await _require_staff_at(db, user, session.restaurant_id)
    return await _build_pending(db, session)


@router.post(
    "/sessions/{session_id}/validate",
    response_model=dict,
)
async def submit_validation(
    session_id: UUID,
    payload: ValidationIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    session = await db.get(MealSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    await _require_staff_at(db, user, session.restaurant_id)

    # Walk-ins bypass the reward path — refuse loudly rather than
    # silently letting a validation land against a session that will
    # never issue a reward.
    if session.entry_channel == "walkin":
        raise HTTPException(
            status_code=400,
            detail={
                "code": "WALKIN_NOT_REWARD_ELIGIBLE",
                "message": "Walk-in orders cannot receive rewards.",
            },
        )

    # Ethics rule 8: staff cannot validate their own diner sessions.
    if session.diner_user_id == user.id:
        raise HTTPException(
            status_code=403, detail="Staff cannot validate their own diner sessions"
        )

    if session.status != "pending_staff_validation":
        # Idempotent same-decision returns existing record.
        existing_result = await db.execute(
            select(StaffValidation).where(StaffValidation.meal_session_id == session.id)
        )
        existing = existing_result.scalar_one_or_none()
        if existing is not None:
            if existing.decision == payload.decision:
                return {"session": _session_dict(session), "validation": _validation_dict(existing)}
            raise ValidationAlreadyDecided()
        raise WrongSessionStatus("pending_staff_validation", session.status)

    score_result = await db.execute(
        select(ConsumptionScore).where(ConsumptionScore.meal_session_id == session.id)
    )
    score = score_result.scalar_one_or_none()
    if score is None:
        raise HTTPException(status_code=409, detail="Score not found for session")

    if payload.decision == "adjusted" and payload.final_score is None:
        raise ValidationRequiresFinalScore()
    if payload.decision in ("adjusted", "rejected") and not payload.reason_code:
        raise ValidationRequiresReasonCode()

    model_score = Decimal(str(score.overall_score))
    if payload.decision == "approved":
        final_score = model_score
    elif payload.decision == "adjusted":
        final_score = Decimal(str(payload.final_score))
    else:  # rejected
        final_score = Decimal("0")

    now = datetime.now(UTC)
    validation = StaffValidation(
        meal_session_id=session.id,
        staff_user_id=user.id,
        restaurant_id=session.restaurant_id,
        decision=payload.decision,
        model_score=model_score,
        final_score=final_score,
        reason_code=payload.reason_code,
        notes=payload.notes,
        decided_at=now,
        # Latency from session entering pending → now. Not the time the
        # individual staff member spent reviewing this case (would need
        # tracking opens) but it's the best signal at this layer.
        decision_latency_ms=int(
            max(0, (now - session.updated_at).total_seconds() * 1000)
        ),
    )
    db.add(validation)

    reward_out: dict[str, Any] | None = None
    if payload.decision == "rejected":
        session.status = "staff_rejected"
    else:
        # approved or adjusted — check threshold
        rule_result = await db.execute(
            select(RewardRule).where(
                RewardRule.restaurant_id == session.restaurant_id,
                RewardRule.is_active.is_(True),
            )
        )
        rule = rule_result.scalar_one_or_none()
        if rule is not None and final_score >= rule.consumption_threshold:
            try:
                await rate_limit.check_rewards_per_restaurant_per_day(
                    session.diner_user_id, session.restaurant_id
                )
            except Exception:  # noqa: BLE001
                # Cap hit → approve but don't issue another reward this day.
                session.status = "staff_approved"
            else:
                # Reward's base value. Precedence: the rule's explicit
                # reward_value_minor override (if set), else fall back to
                # the linked menu item's price. If the diner later switches
                # to bill_discount, we'll re-anchor on the rule's
                # bill_discount_minor (or fall back to this).
                reward_item = await db.get(MenuItem, rule.reward_menu_item_id)
                menu_value = (
                    rule.reward_value_minor
                    if rule.reward_value_minor is not None
                    else (reward_item.price_minor if reward_item is not None else 0)
                )
                half_value_at = now + timedelta(days=settings.REWARD_FULL_VALUE_DAYS)
                expires_at = now + timedelta(days=settings.REWARD_EXPIRY_DAYS)
                reward = Reward(
                    meal_session_id=session.id,
                    reward_rule_id=rule.id,
                    redemption_code=new_redemption_code(),
                    reward_type="menu_item",
                    value_minor=menu_value,
                    issued_at=now,
                    half_value_at=half_value_at,
                    expires_at=expires_at,
                )
                db.add(reward)
                session.status = "rewarded"
                await db.flush()
                reward_out = {
                    "id": str(reward.id),
                    "redemption_code": reward.redemption_code,
                    "reward_type": reward.reward_type,
                    "value_minor": reward.value_minor,
                    "half_value_at": reward.half_value_at.isoformat(),
                    "expires_at": reward.expires_at.isoformat(),
                    "allowed_reward_types": list(rule.allowed_reward_types or []),
                }
                # Anonymous-mode SMS delivery (CLAUDE.md §9 Phase 3).
                # If the diner is a phone-only user, fire the reward SMS
                # so they get the code even if they've closed the PWA.
                # Non-blocking: failure to dispatch must not roll back
                # the reward — staff already approved it.
                try:
                    diner = await db.get(User, session.diner_user_id)
                    restaurant_obj = await db.get(
                        Restaurant, session.restaurant_id
                    )
                    if (
                        diner is not None
                        and restaurant_obj is not None
                        and sms.is_phone_only_user(diner.email, diner.phone)
                    ):
                        sms.send_reward_sms(
                            phone=diner.phone,
                            code=reward.redemption_code,
                            restaurant_name=restaurant_obj.name,
                        )
                except Exception:  # noqa: BLE001, S110
                    # Belt and braces — SMS errors must never affect the
                    # reward grant. The dispatcher already logs.
                    pass
        else:
            session.status = "staff_approved"

    await db.commit()
    await db.refresh(validation)
    await db.refresh(session)

    return {
        "session": _session_dict(session),
        "validation": _validation_dict(validation),
        "reward": reward_out,
    }


@router.post("/sessions/{session_id}/validate/escalate", response_model=dict)
async def escalate(
    session_id: UUID,
    payload: EscalateIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    session = await db.get(MealSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    await _require_staff_at(db, user, session.restaurant_id)
    if session.status != "pending_staff_validation":
        raise WrongSessionStatus("pending_staff_validation", session.status)
    session.escalated = True
    # Notes are recorded in fraud_signals so the manager sees them with context.
    from app.services import fraud as fraud_service  # noqa: PLC0415

    await fraud_service.record(
        db,
        signal_type="manual_flag",
        severity="info",
        details={"reason": "staff_escalated", "notes": payload.notes, "staff_user_id": str(user.id)},
        meal_session_id=session.id,
    )
    await db.commit()
    return {"session": _session_dict(session)}


# -- helpers ----------------------------------------------------------------


async def _build_pending(db: AsyncSession, session: MealSession) -> PendingValidationOut:
    score_result = await db.execute(
        select(ConsumptionScore).where(ConsumptionScore.meal_session_id == session.id)
    )
    score = score_result.scalar_one_or_none()

    caps_result = await db.execute(
        select(PlateCapture).where(PlateCapture.meal_session_id == session.id)
    )
    captures = {c.phase: c for c in caps_result.scalars().all()}

    items_result = await db.execute(
        select(MealSessionItem, MenuItem)
        .join(MenuItem, MealSessionItem.menu_item_id == MenuItem.id)
        .where(MealSessionItem.meal_session_id == session.id)
    )
    ordered_items = [
        {
            "name": menu.name,
            "quantity": item.quantity,
            "portion_size": item.portion_size,
            "notes": item.notes,
        }
        for item, menu in items_result.all()
    ]

    fraud_result = await db.execute(
        select(FraudSignal).where(FraudSignal.meal_session_id == session.id)
    )
    fraud_signals = [
        {
            "signal_type": f.signal_type,
            "severity": f.severity,
            "details": f.details,
            "created_at": f.created_at.isoformat(),
        }
        for f in fraud_result.scalars().all()
    ]

    age_seconds = 0
    if score is not None:
        age_seconds = int((datetime.now(UTC) - score.created_at).total_seconds())

    return PendingValidationOut(
        session_id=session.id,
        table_code=session.table_code,
        score=float(score.overall_score) if score else 0.0,
        score_age_seconds=age_seconds,
        before_image_url=storage.signed_url(captures["before"].image_s3_key)
        if "before" in captures
        else "",
        after_image_url=storage.signed_url(captures["after"].image_s3_key)
        if "after" in captures
        else "",
        ordered_items=ordered_items,
        model_notes=score.notes if score else None,
        model_confidence=float(score.confidence) if score and score.confidence is not None else None,
        suspicious=bool(score.suspicious) if score else False,
        fraud_signals=fraud_signals,
    )


def _session_dict(s: MealSession) -> dict[str, Any]:
    return {
        "id": str(s.id),
        "status": s.status,
        "restaurant_id": str(s.restaurant_id),
        "diner_user_id": str(s.diner_user_id) if s.diner_user_id else None,
        "started_at": s.started_at.isoformat(),
        "expires_at": s.expires_at.isoformat(),
    }


def _validation_dict(v: StaffValidation) -> dict[str, Any]:
    return {
        "id": str(v.id),
        "decision": v.decision,
        "model_score": float(v.model_score),
        "final_score": float(v.final_score),
        "reason_code": v.reason_code,
        "notes": v.notes,
        "decided_at": v.decided_at.isoformat(),
    }
