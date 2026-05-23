"""Schemas for self-service restaurant onboarding (Phase 2 §9).

Combines the owner sign-up payload + the restaurant-create payload into
one atomic request. Validation rules and field bounds mirror the
underlying RegisterIn + RestaurantCreateIn schemas so the same
constraints apply whether a stranger onboards themselves or a platform
admin does it.
"""
from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field, HttpUrl

from app.schemas.auth import UserOut
from app.schemas.restaurant import RestaurantOut


class OnboardOwnerIn(BaseModel):
    """The person about to take ownership of the new restaurant."""

    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    display_name: str | None = Field(default=None, max_length=100)
    is_adult: bool = Field(
        description="Owner confirms they are 18+. Ethics rule 4."
    )


class OnboardRestaurantIn(BaseModel):
    """The restaurant the owner is claiming. Same constraints as
    RestaurantCreateIn so admin-driven and self-service create the same
    shape of row."""

    name: str = Field(min_length=1, max_length=120)
    slug: str = Field(min_length=2, max_length=64, pattern=r"^[a-z0-9-]+$")
    address: str = Field(min_length=1, max_length=400)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    geofence_radius_m: int = Field(default=100, ge=20, le=2000)
    timezone: str = Field(default="Asia/Kolkata", max_length=64)
    currency: str = Field(default="INR", min_length=3, max_length=3)
    theme_primary_color: str = Field(
        default="#0f766e", pattern=r"^#[0-9a-fA-F]{6}$"
    )
    theme_logo_url: HttpUrl | None = None
    tagline: str | None = Field(default=None, max_length=200)


class OnboardIn(BaseModel):
    owner: OnboardOwnerIn
    restaurant: OnboardRestaurantIn


class OnboardOut(BaseModel):
    """What the caller gets back: a usable JWT + the user + restaurant.
    The frontend can immediately call any owner-scoped endpoint with the
    returned token."""

    token: str
    user: UserOut
    restaurant: RestaurantOut
