import asyncio
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status


def secrets_uuid() -> str:
    """Enumeration-safe placeholder request_id for the case where the
    user we'd reset doesn't exist. `uuid4` is unpredictable enough
    that an attacker can't guess a "real" request_id from one of
    these fake ones."""
    return str(uuid4())
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.errors import ApiError
from app.models.dispute import Dispute
from app.models.meal_session import MealSession, MealSessionItem
from app.models.menu_item import MenuItem
from app.models.restaurant import Restaurant
from app.models.staff_validation import StaffValidation
from app.models.user import User
from app.schemas.auth import (
    AuthOut,
    ChangePasswordIn,
    ForgotPasswordIn,
    ForgotPasswordOut,
    GoogleSignInIn,
    LoginIn,
    OtpRequestIn,
    OtpRequestOut,
    OtpVerifyIn,
    RegisterIn,
    ResetPasswordIn,
    UserOut,
    UserPatchIn,
)
from app.security import create_access_token, get_current_user, hash_password, verify_password
from app.services import rate_limit, sustainability as sustainability_svc
from app.services.otp import request_otp, request_reset_otp, verify_otp, verify_reset_otp

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

    phone = payload.phone.strip()
    # Both email + phone are unique-indexed on `users`; a conflict on
    # either raises IntegrityError. We disambiguate the error code so
    # the frontend can highlight the right field.
    email_taken = await db.execute(
        select(User).where(User.email == str(payload.email).lower())
    )
    if email_taken.scalar_one_or_none() is not None:
        raise ApiError(
            status_code=status.HTTP_409_CONFLICT,
            code="EMAIL_TAKEN",
            message="An account with this email already exists.",
        )
    phone_taken = await db.execute(select(User).where(User.phone == phone))
    if phone_taken.scalar_one_or_none() is not None:
        raise ApiError(
            status_code=status.HTTP_409_CONFLICT,
            code="PHONE_TAKEN",
            message="An account with this phone already exists.",
        )

    user = User(
        email=str(payload.email).lower(),
        phone=phone,
        display_name=payload.display_name,
        password_hash=hash_password(payload.password),
        role="diner",
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError as exc:
        # Race: two concurrent registrations with the same email/phone
        # slip past the pre-check. Fall back to a generic conflict.
        await db.rollback()
        raise ApiError(
            status_code=status.HTTP_409_CONFLICT,
            code="ACCOUNT_TAKEN",
            message="Email or phone is already in use.",
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


@router.post("/google", response_model=AuthOut)
async def sign_in_with_google(
    payload: GoogleSignInIn, db: AsyncSession = Depends(get_db)
) -> AuthOut:
    """Exchange a Google Identity Services ID token for one of our
    own JWTs.

    Lookup + account-linking rules:
      1. If a user already has this google_sub → sign them in.
      2. Else if a user with the same email exists (password or
         phone-OTP account) → LINK: set their google_sub, keep
         everything else. From now on they can auth either way.
      3. Else → create a fresh diner account with the Google email
         and display_name.

    This means diners who signed up with email+password months ago
    can start using "Continue with Google" seamlessly the first time
    they click it — no duplicate accounts, no "email already exists"
    error.

    If GOOGLE_CLIENT_ID isn't configured we return 503 rather than
    500 so the frontend can render a "Google sign-in isn't set up
    yet" message instead of a scary error page.
    """
    from app.config import get_settings  # noqa: PLC0415 — circular-safe local import
    from app.services.google_auth import (  # noqa: PLC0415
        InvalidGoogleToken,
        verify_google_id_token,
    )

    settings = get_settings()
    if not settings.GOOGLE_CLIENT_ID:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "GOOGLE_NOT_CONFIGURED",
                "message": (
                    "Google sign-in isn't set up on this deployment. "
                    "Use email + password or phone OTP."
                ),
            },
        )

    # `verify_google_id_token` is blocking (fetches Google's JWKs on
    # cold cache). Push to a thread so we don't stall the event loop
    # on the first sign-in after a worker restart.
    try:
        claims = await asyncio.to_thread(
            verify_google_id_token,
            payload.id_token,
            client_id=settings.GOOGLE_CLIENT_ID,
        )
    except InvalidGoogleToken as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "INVALID_GOOGLE_TOKEN",
                "message": str(exc) or "Google token verification failed",
            },
        ) from exc

    # Step 1 — existing account linked by google_sub.
    result = await db.execute(
        select(User).where(
            User.google_sub == claims.sub, User.deleted_at.is_(None)
        )
    )
    user = result.scalar_one_or_none()

    if user is None:
        # Step 2 — link into a pre-existing password / phone-OTP
        # account with the same verified email.
        result = await db.execute(
            select(User).where(
                User.email == claims.email, User.deleted_at.is_(None)
            )
        )
        existing = result.scalar_one_or_none()
        if existing is not None:
            existing.google_sub = claims.sub
            if not existing.display_name and claims.name:
                existing.display_name = claims.name
            user = existing
        else:
            # Step 3 — brand-new diner account.
            user = User(
                email=claims.email,
                display_name=claims.name,
                google_sub=claims.sub,
                role="diner",
                # Google's `email_verified: true` is already enforced
                # in the verifier, so we can trust the address as
                # verified from the moment the user exists.
                email_verified_at=datetime.now(UTC),
            )
            db.add(user)

    user.last_login_at = datetime.now(UTC)
    await db.commit()
    await db.refresh(user)
    token = create_access_token(user.id, extra_claims={"role": user.role})
    return AuthOut(user=UserOut.model_validate(user), token=token)


@router.post("/otp/request", response_model=OtpRequestOut)
async def otp_request(payload: OtpRequestIn) -> OtpRequestOut:
    # Per-phone rate limit is applied BEFORE we issue the OTP so an
    # attacker paying for a Redis INCR (essentially free) can't burn
    # our SMS budget (₹0.20+ each). See rate_limit.check_otp_requests.
    await rate_limit.check_otp_requests(payload.phone)
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


@router.post("/forgot-password", response_model=ForgotPasswordOut)
async def forgot_password(
    payload: ForgotPasswordIn, db: AsyncSession = Depends(get_db)
) -> ForgotPasswordOut:
    """Kick off a password reset. Identifier can be an email or a
    phone; we look the user up by either. The OTP is always delivered
    to the phone on file — SMTP-based reset links are Phase 2.

    Enumeration hardening: we return the same success shape whether
    or not the account exists (with a synthesised request_id if it
    doesn't). An attacker can't distinguish "no such user" from
    "user exists but has no phone" from just the response.
    """
    identifier = payload.identifier.strip()
    # Rate limit on the identifier itself (not just the phone we
    # eventually SMS to) so an attacker can't grind through a stolen
    # email list one address at a time. The bucket is normalised so
    # case + whitespace variants don't split windows.
    await rate_limit.check_otp_requests(identifier)
    is_email = "@" in identifier
    if is_email:
        result = await db.execute(
            select(User).where(
                User.email == identifier.lower(), User.deleted_at.is_(None)
            )
        )
    else:
        result = await db.execute(
            select(User).where(User.phone == identifier, User.deleted_at.is_(None))
        )
    user = result.scalar_one_or_none()

    # Reset must work even for accounts that pre-date the
    # phone-required signup migration (they have an email but
    # `phone=None`). We attempt every channel the user has on file
    # and fall back to a noop request_id only when there's literally
    # no way to reach them.
    routable_email = (
        user.email
        if user is not None and not user.email.endswith("@plate-clean.local")
        else None
    )
    routable_phone = user.phone if user is not None else None

    if user is None or (not routable_email and not routable_phone):
        # Enumeration hardening — return a request_id that will never
        # verify. Same shape as the happy path so an attacker can't
        # distinguish success from failure client-side.
        return ForgotPasswordOut(
            request_id=f"noop-{secrets_uuid()}", delivery="sms+email"
        )

    request_id, delivered = await request_reset_otp(
        user_id=user.id, phone=routable_phone, email=routable_email
    )
    delivery = "+".join(delivered) if delivered else "sms+email"
    return ForgotPasswordOut(request_id=request_id, delivery=delivery)


@router.post("/reset-password", response_model=AuthOut)
async def reset_password(
    payload: ResetPasswordIn, db: AsyncSession = Depends(get_db)
) -> AuthOut:
    """Verify the OTP issued by /forgot-password, then set the new
    password. Returns a fresh auth token so the user is signed in
    directly — no second sign-in round-trip after a reset.

    The reset OTP is keyed by user_id (not phone), so accounts with
    only an email — including anyone who signed up before the
    phone-required migration — recover cleanly through this path.
    """
    user_id = await verify_reset_otp(payload.request_id, payload.code)
    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired reset code",
        )
    user = await db.get(User, user_id)
    if user is None or user.deleted_at is not None:
        # OTP verified but user was deleted between forgot + reset.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Account not found"
        )
    user.password_hash = hash_password(payload.new_password)
    user.last_login_at = datetime.now(UTC)
    await db.commit()
    await db.refresh(user)
    token = create_access_token(user.id, extra_claims={"role": user.role})
    return AuthOut(user=UserOut.model_validate(user), token=token)


@router.post("/change-password", response_model=UserOut)
async def change_password(
    payload: ChangePasswordIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserOut:
    """Signed-in password rotation for anyone who still remembers
    their current password. Distinct from /reset-password (no OTP)
    because the JWT is proof-of-identity here.

    Rejects if:
      - The user has no password_hash on file (phone-OTP-only accounts
        — they use /reset-password with an OTP instead).
      - current_password doesn't verify.
      - new_password equals current_password (nudges the user to
        actually change it — otherwise the endpoint is a no-op that
        wastes a database write).
    """
    if user.password_hash is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This account has no password set. Use forgot-password to set one.",
        )
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Current password is incorrect.",
        )
    if payload.current_password == payload.new_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must be different from the current one.",
        )
    user.password_hash = hash_password(payload.new_password)
    await db.commit()
    await db.refresh(user)
    return UserOut.model_validate(user)


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)) -> UserOut:
    return UserOut.model_validate(user)


@router.patch("/me", response_model=UserOut)
async def patch_me(
    payload: UserPatchIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserOut:
    """Self-service profile edits — display name + image retention window
    (ethics rule 6's per-user 7..90-day opt-in)."""
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(user, key, value)
    await db.commit()
    await db.refresh(user)
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


@router.get("/me/sustainability")
async def my_sustainability(
    days: int = Query(default=30, ge=1, le=365),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Ethics rule 3: 'you saved 0.4 kg CO₂e this month' encouraged copy.

    Pulls every staff-validated meal session this diner had in the last
    `days`, looks up the ordered items + their categories, and runs them
    through services.sustainability.compute. Defaults to 30 days so
    "this month" reads naturally on the diner Profile.
    """
    since = datetime.now(UTC) - timedelta(days=days)
    rows = await db.execute(
        select(
            StaffValidation.final_score,
            MealSessionItem.quantity,
            MenuItem.category,
        )
        .join(MealSession, MealSession.id == StaffValidation.meal_session_id)
        .join(MealSessionItem, MealSessionItem.meal_session_id == MealSession.id)
        .join(MenuItem, MenuItem.id == MealSessionItem.menu_item_id)
        .where(
            MealSession.diner_user_id == user.id,
            StaffValidation.decided_at >= since,
            StaffValidation.decision.in_(("approved", "adjusted")),
        )
    )
    # Group items by validation (one row per item).
    by_session: dict[Decimal, list[tuple[str | None, int]]] = {}
    for final_score, quantity, category in rows.all():
        key = Decimal(str(final_score))
        by_session.setdefault(key, []).append((category, int(quantity)))
    sessions = [
        sustainability_svc.SessionInput(final_score=score, item_categories=items)
        for score, items in by_session.items()
    ]
    report = sustainability_svc.compute(sessions, period_days=days)
    return {
        "period_days": report.period_days,
        "sessions_counted": report.sessions_counted,
        "kg_food_saved": report.kg_food_saved,
        "kg_co2e_saved": report.kg_co2e_saved,
        "trees_day_equivalent": report.trees_day_equivalent,
    }


@router.get("/me/disputes")
async def my_disputes(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Diner's own dispute history — open + resolved. Feeds the
    Disputes card on the Profile screen so a diner can see what
    they filed and how it was resolved. Sorted newest first;
    resolved rows carry the resolution timestamp + notes."""
    rows = await db.execute(
        select(Dispute, MealSession, Restaurant)
        .join(MealSession, Dispute.meal_session_id == MealSession.id)
        .join(Restaurant, Restaurant.id == MealSession.restaurant_id)
        .where(Dispute.raised_by_user_id == user.id)
        .order_by(Dispute.created_at.desc())
    )
    return [
        {
            "id": str(d.id),
            "meal_session_id": str(d.meal_session_id),
            "table_code": s.table_code,
            "restaurant_name": r.name,
            "reason": d.reason,
            "status": d.status,
            "created_at": d.created_at.isoformat(),
            "resolved_at": d.resolved_at.isoformat() if d.resolved_at else None,
            "resolution_notes": d.resolution_notes,
        }
        for d, s, r in rows.all()
    ]
