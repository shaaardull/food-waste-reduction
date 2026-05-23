"""Self-service restaurant onboarding (Phase 2 §9: "no platform admin
needed"). A stranger can sign up, claim a restaurant by slug, and walk
out the other end with a JWT scoped as the owner of their new
restaurant — ready to add menu items, set up the reward rule, and
invite staff.

Atomic. Either all three rows land (User + Restaurant + RestaurantStaff)
or none do. Slug collision → 409. Email collision → 409.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.errors import ApiError
from app.models.restaurant import Restaurant, RestaurantStaff
from app.models.user import User
from app.schemas.auth import UserOut
from app.schemas.onboarding import OnboardIn, OnboardOut
from app.schemas.restaurant import RestaurantOut
from app.security import create_access_token, hash_password

router = APIRouter()


@router.post(
    "/restaurant",
    response_model=OnboardOut,
    status_code=status.HTTP_201_CREATED,
)
async def onboard_restaurant(
    payload: OnboardIn,
    db: AsyncSession = Depends(get_db),
) -> OnboardOut:
    """Atomically create the owner, the restaurant, and the
    owner-membership link. Returns a usable JWT so the frontend can
    immediately drive the rest of the wizard against owner-scoped
    endpoints."""
    # Ethics rule 4 — minor protection. Same message family as /auth/register.
    if not payload.owner.is_adult:
        raise ApiError(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="MINOR_NOT_PERMITTED",
            message="You must be 18 or older to create an account.",
        )

    email_lower = str(payload.owner.email).lower()
    # Early-out check on email to give a clean 409 instead of a generic
    # IntegrityError at the end. The transaction below still catches
    # the race where two concurrent onboardings pick the same email.
    existing = await db.execute(select(User.id).where(User.email == email_lower))
    if existing.scalar_one_or_none() is not None:
        raise ApiError(
            status_code=status.HTTP_409_CONFLICT,
            code="EMAIL_TAKEN",
            message="An account with this email already exists.",
        )

    # Same pre-check for slug — cheaper than rolling back the user
    # insert if the slug is taken.
    existing_slug = await db.execute(
        select(Restaurant.id).where(Restaurant.slug == payload.restaurant.slug)
    )
    if existing_slug.scalar_one_or_none() is not None:
        raise ApiError(
            status_code=status.HTTP_409_CONFLICT,
            code="SLUG_TAKEN",
            message=f"slug '{payload.restaurant.slug}' already exists",
        )

    user = User(
        email=email_lower,
        password_hash=hash_password(payload.owner.password),
        display_name=payload.owner.display_name,
        role="staff",
    )
    restaurant = Restaurant(
        name=payload.restaurant.name,
        slug=payload.restaurant.slug,
        address=payload.restaurant.address,
        latitude=payload.restaurant.latitude,
        longitude=payload.restaurant.longitude,
        geofence_radius_m=payload.restaurant.geofence_radius_m,
        timezone=payload.restaurant.timezone,
        currency=payload.restaurant.currency,
        is_active=True,
        theme_primary_color=payload.restaurant.theme_primary_color,
        theme_logo_url=(
            str(payload.restaurant.theme_logo_url)
            if payload.restaurant.theme_logo_url
            else None
        ),
        tagline=payload.restaurant.tagline,
    )
    db.add(user)
    db.add(restaurant)
    try:
        await db.flush()
        db.add(
            RestaurantStaff(
                user_id=user.id, restaurant_id=restaurant.id, role="owner"
            )
        )
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        # Race: two concurrent calls picked the same slug or email.
        # The pre-checks above catch the common case; this is the
        # belt-and-braces for the rare race.
        raise ApiError(
            status_code=status.HTTP_409_CONFLICT,
            code="CONFLICT",
            message="Email or slug already exists.",
        ) from exc

    await db.refresh(user)
    await db.refresh(restaurant)

    token = create_access_token(user.id, extra_claims={"role": user.role})
    return OnboardOut(
        token=token,
        user=UserOut.model_validate(user),
        restaurant=RestaurantOut.model_validate(restaurant),
    )
