from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, HttpUrl


class RestaurantOut(BaseModel):
    id: UUID
    name: str
    slug: str
    address: str
    latitude: float
    longitude: float
    geofence_radius_m: int
    timezone: str
    currency: str
    is_active: bool
    theme_primary_color: str
    theme_logo_url: str | None = None
    tagline: str | None = None

    model_config = {"from_attributes": True}


class RestaurantCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    slug: str = Field(min_length=2, max_length=64, pattern=r"^[a-z0-9-]+$")
    address: str = Field(min_length=1, max_length=400)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    geofence_radius_m: int = Field(default=100, ge=20, le=2000)
    timezone: str = Field(default="UTC", max_length=64)
    currency: str = Field(default="INR", min_length=3, max_length=3)
    theme_primary_color: str = Field(default="#0f766e", pattern=r"^#[0-9a-fA-F]{6}$")
    theme_logo_url: HttpUrl | None = None
    tagline: str | None = Field(default=None, max_length=200)


class RestaurantPatchIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    address: str | None = Field(default=None, min_length=1, max_length=400)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    geofence_radius_m: int | None = Field(default=None, ge=20, le=2000)
    timezone: str | None = Field(default=None, max_length=64)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    is_active: bool | None = None
    theme_primary_color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    theme_logo_url: HttpUrl | None = None
    tagline: str | None = Field(default=None, max_length=200)


class MenuItemOut(BaseModel):
    id: UUID
    restaurant_id: UUID
    name: str
    description: str | None = None
    price_minor: int
    category: str | None = None
    is_reward_eligible: bool
    is_active: bool
    reference_image_url: str | None = None

    model_config = {"from_attributes": True}


MenuCategory = Literal["starter", "main", "side", "bread", "drink", "dessert"]


class MenuItemIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=400)
    price_minor: int = Field(ge=0, le=1_000_000_00)
    category: MenuCategory | None = None
    is_reward_eligible: bool = False
    reference_image_url: HttpUrl | None = None


class MenuItemsBulkIn(BaseModel):
    items: list[MenuItemIn] = Field(min_length=1, max_length=200)


class MenuItemPatchIn(BaseModel):
    """Partial update — every field optional. Frontend Menu editor
    PATCHes only what changed, so a price tweak doesn't have to
    re-send name / description / etc."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=400)
    price_minor: int | None = Field(default=None, ge=0, le=1_000_000_00)
    category: MenuCategory | None = None
    is_reward_eligible: bool | None = None
    is_active: bool | None = None
    reference_image_url: HttpUrl | None = None


class RewardRuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    consumption_threshold: Decimal = Field(ge=Decimal("0.50"), le=Decimal("0.95"))
    reward_menu_item_id: UUID
    daily_redemption_cap_per_user: int = Field(default=1, ge=1, le=10)
    allowed_reward_types: list[Literal["menu_item", "bill_discount"]] = Field(
        default_factory=lambda: ["menu_item", "bill_discount"], min_length=1
    )
    bill_discount_minor: int | None = Field(default=None, ge=0, le=1_000_000_00)


class RewardRuleOut(BaseModel):
    id: UUID
    restaurant_id: UUID
    name: str
    consumption_threshold: Decimal
    reward_menu_item_id: UUID
    daily_redemption_cap_per_user: int
    is_active: bool
    allowed_reward_types: list[str]
    bill_discount_minor: int | None = None

    model_config = {"from_attributes": True}


class StaffInviteIn(BaseModel):
    # EmailStr so the address is loggable into /auth/login afterwards — the
    # admin wizard would otherwise be able to create accounts no one can use.
    email: EmailStr
    display_name: str | None = Field(default=None, max_length=100)
    role: Literal["owner", "manager", "server"] = "manager"
    password: str = Field(min_length=8, max_length=128)


class StaffInviteOut(BaseModel):
    user_id: UUID
    email: str
    role: str
