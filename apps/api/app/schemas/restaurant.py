from uuid import UUID

from pydantic import BaseModel


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

    model_config = {"from_attributes": True}


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
