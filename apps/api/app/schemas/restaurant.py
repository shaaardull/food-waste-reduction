from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, HttpUrl

# India GSTIN — 15 chars, format: 2 digit state code + 10 char PAN +
# 1 entity code + 1 alphabet (default Z) + 1 checksum. We match on
# the length + charset rather than the checksum to keep validation
# forgiving for the pilot; strict verification via the GSTN portal
# is a separate concern.
_GSTIN_PATTERN = r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9A-Z]{1}Z[0-9A-Z]{1}$"


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
    # GST config (Gap-D). Every bill snapshots the rate at issue time
    # so a later change here doesn't retroactively re-price past bills.
    gstin: str | None = None
    gst_rate: Decimal = Decimal("0.050")
    hsn_code: str = "9963"
    bill_prefix: str | None = None
    # E1 toggle — flip off to skip the CGST/SGST split on new bills.
    # Past bills keep their snapshot rate; only future bills follow
    # the new setting.
    gst_enabled: bool = True

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
    # GST config. All optional at create time — most pilot restaurants
    # don't have their GSTIN handy on day one; they patch it in later.
    gstin: str | None = Field(default=None, pattern=_GSTIN_PATTERN)
    gst_rate: Decimal | None = Field(
        default=None, ge=Decimal("0.00"), le=Decimal("0.28")
    )
    hsn_code: str | None = Field(default=None, min_length=4, max_length=8)
    bill_prefix: str | None = Field(default=None, max_length=32)
    gst_enabled: bool | None = None


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
    gstin: str | None = Field(default=None, pattern=_GSTIN_PATTERN)
    # gst_rate ceiling of 0.28 covers the max slab in India (28% on
    # sin-goods). Real restaurant food is either 5% or 18%; the wide
    # range exists so we don't need another migration if the tax
    # code changes.
    gst_rate: Decimal | None = Field(
        default=None, ge=Decimal("0.00"), le=Decimal("0.28")
    )
    hsn_code: str | None = Field(default=None, min_length=4, max_length=8)
    bill_prefix: str | None = Field(default=None, max_length=32)
    gst_enabled: bool | None = None


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


# Historical seed categories — still used by the vision-extraction
# coerce (a hallucinated category is dropped to None). Staff can
# freely define new categories through the menu editor; the DB column
# is plain TEXT so anything reasonable-length works.
MenuCategory = Literal["starter", "main", "side", "bread", "drink", "dessert"]


class MenuItemIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=400)
    price_minor: int = Field(ge=0, le=1_000_000_00)
    # Free-form category so a restaurant can group by "Tandoor",
    # "Coastal specials", "Kids menu" etc. — anything meaningful for
    # their menu. Capped at 40 chars so the diner UI can render it as
    # a section header without wrapping.
    category: str | None = Field(default=None, max_length=40)
    is_reward_eligible: bool = False
    reference_image_url: HttpUrl | None = None


class MenuItemsBulkIn(BaseModel):
    items: list[MenuItemIn] = Field(min_length=1, max_length=200)


class MenuExtractedItemOut(BaseModel):
    """A single proposed dish from a menu-card scan. Not persisted to
    menu_items until the staff confirms it via POST /menu-items —
    every field is server-decoded from the Claude tool call. Names
    match MenuItemIn so the frontend can round-trip a confirmed item
    without re-mapping."""

    name: str
    description: str | None = None
    price_minor: int
    category: str | None = None
    confidence: float


class MenuExtractionOut(BaseModel):
    """Response to POST /menu-items/extract. `extraction_id` lets the
    frontend echo it back on the follow-up bulk-add so we can update
    `items_accepted` for prompt-tuning telemetry."""

    extraction_id: UUID
    items: list[MenuExtractedItemOut]
    detected_currency: str
    confidence: float
    notes: str | None = None
    processing_ms: int
    model_name: str
    model_version: str


class MenuItemPatchIn(BaseModel):
    """Partial update — every field optional. Frontend Menu editor
    PATCHes only what changed, so a price tweak doesn't have to
    re-send name / description / etc."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=400)
    price_minor: int | None = Field(default=None, ge=0, le=1_000_000_00)
    # Same rules as MenuItemIn: free-form, 40-char cap. Passing "" is
    # coerced to None at the router since Pydantic keeps empty strings.
    category: str | None = Field(default=None, max_length=40)
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
    # Override the rupee value the reward mints at. Null → fall back to the
    # linked menu item's price. Must be strictly positive when set — a
    # zero-value reward is meaningless.
    reward_value_minor: int | None = Field(default=None, gt=0, le=1_000_000_00)


class RewardRulePatch(BaseModel):
    """Partial update for a reward rule. Fields left absent stay as-is.

    `reward_value_minor` is tri-state: absent = don't touch, null = clear
    the override, positive int = set the override.
    """

    model_config = {"extra": "forbid"}

    name: str | None = Field(default=None, min_length=1, max_length=120)
    consumption_threshold: Decimal | None = Field(
        default=None, ge=Decimal("0.50"), le=Decimal("0.95")
    )
    daily_redemption_cap_per_user: int | None = Field(default=None, ge=1, le=10)
    is_active: bool | None = None
    allowed_reward_types: list[Literal["menu_item", "bill_discount"]] | None = Field(
        default=None, min_length=1
    )
    bill_discount_minor: int | None = Field(default=None, ge=0, le=1_000_000_00)
    reward_value_minor: int | None = Field(default=None, gt=0, le=1_000_000_00)


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
    reward_value_minor: int | None = None

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
