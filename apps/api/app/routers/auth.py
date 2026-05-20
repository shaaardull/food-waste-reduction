from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.errors import ApiError
from app.models.user import User
from app.schemas.auth import (
    AuthOut,
    LoginIn,
    OtpRequestIn,
    OtpRequestOut,
    OtpVerifyIn,
    RegisterIn,
    UserOut,
)
from app.security import create_access_token, get_current_user, hash_password, verify_password
from app.services.otp import request_otp, verify_otp

router = APIRouter()


@router.post("/register", response_model=AuthOut, status_code=status.HTTP_201_CREATED)
async def register(payload: RegisterIn, db: AsyncSession = Depends(get_db)) -> AuthOut:
    # Ethics rule 4: minor protection.
    if not payload.is_adult:
        raise ApiError(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="MINOR_NOT_PERMITTED",
            message="You must be 18 or older to create an account.",
        )

    user = User(
        email=str(payload.email).lower(),
        display_name=payload.display_name,
        password_hash=hash_password(payload.password),
        role="diner",
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise ApiError(
            status_code=status.HTTP_409_CONFLICT,
            code="EMAIL_TAKEN",
            message="An account with this email already exists.",
        ) from exc
    await db.refresh(user)
    token = create_access_token(user.id, extra_claims={"role": user.role})
    return AuthOut(user=UserOut.model_validate(user), token=token)


@router.post("/login", response_model=AuthOut)
async def login(payload: LoginIn, db: AsyncSession = Depends(get_db)) -> AuthOut:
    result = await db.execute(
        select(User).where(User.email == str(payload.email).lower(), User.deleted_at.is_(None))
    )
    user = result.scalar_one_or_none()
    if user is None or user.password_hash is None or not verify_password(
        payload.password, user.password_hash
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials"
        )
    user.last_login_at = datetime.now(UTC)
    await db.commit()
    await db.refresh(user)
    token = create_access_token(user.id, extra_claims={"role": user.role})
    return AuthOut(user=UserOut.model_validate(user), token=token)


@router.post("/otp/request", response_model=OtpRequestOut)
async def otp_request(payload: OtpRequestIn) -> OtpRequestOut:
    request_id = await request_otp(payload.phone)
    return OtpRequestOut(request_id=request_id)


@router.post("/otp/verify", response_model=AuthOut)
async def otp_verify(payload: OtpVerifyIn, db: AsyncSession = Depends(get_db)) -> AuthOut:
    phone = await verify_otp(payload.request_id, payload.code)
    if phone is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired OTP"
        )
    result = await db.execute(select(User).where(User.phone == phone, User.deleted_at.is_(None)))
    user = result.scalar_one_or_none()
    if user is None:
        # Auto-provision a diner account for new phone numbers.
        synthetic_email = f"phone+{phone.replace('+', '').replace(' ', '')}@plate-clean.local"
        user = User(email=synthetic_email, phone=phone, role="diner")
        db.add(user)
    user.last_login_at = datetime.now(UTC)
    await db.commit()
    await db.refresh(user)
    token = create_access_token(user.id, extra_claims={"role": user.role})
    return AuthOut(user=UserOut.model_validate(user), token=token)


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)) -> UserOut:
    return UserOut.model_validate(user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(_: User = Depends(get_current_user)) -> None:
    # JWTs are stateless; client discards the token. A token revocation list
    # is an optional Phase 2 hardening.
    return None


@router.delete("/me", status_code=status.HTTP_202_ACCEPTED)
async def delete_account(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict[str, str]:
    """Ethics rule 5: one-tap delete. Marks deleted_at; nightly job purges associated data."""
    user.deleted_at = datetime.now(UTC)
    user.email = f"deleted+{user.id}@plate-clean.local"
    user.phone = None
    user.password_hash = None
    user.display_name = None
    await db.commit()
    return {"status": "deletion_scheduled"}
