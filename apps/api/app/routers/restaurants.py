from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.menu_item import MenuItem
from app.models.restaurant import Restaurant
from app.schemas.restaurant import MenuItemOut, RestaurantOut
from app.security import haversine_m

router = APIRouter()


@router.get("", response_model=list[RestaurantOut])
async def list_restaurants(
    db: AsyncSession = Depends(get_db),
    lat: float | None = Query(default=None),
    lng: float | None = Query(default=None),
    radius_km: float | None = Query(default=None, gt=0, le=200),
) -> list[RestaurantOut]:
    result = await db.execute(select(Restaurant).where(Restaurant.is_active.is_(True)))
    restaurants = list(result.scalars().all())
    if lat is not None and lng is not None and radius_km is not None:
        max_m = radius_km * 1000
        restaurants = [
            r for r in restaurants if haversine_m(lat, lng, r.latitude, r.longitude) <= max_m
        ]
    return [RestaurantOut.model_validate(r) for r in restaurants]


@router.get("/{slug}", response_model=RestaurantOut)
async def get_restaurant(slug: str, db: AsyncSession = Depends(get_db)) -> RestaurantOut:
    result = await db.execute(select(Restaurant).where(Restaurant.slug == slug))
    restaurant = result.scalar_one_or_none()
    if restaurant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Restaurant not found")
    return RestaurantOut.model_validate(restaurant)


@router.get("/{restaurant_id}/menu", response_model=list[MenuItemOut])
async def get_menu(restaurant_id: UUID, db: AsyncSession = Depends(get_db)) -> list[MenuItemOut]:
    result = await db.execute(
        select(MenuItem).where(MenuItem.restaurant_id == restaurant_id, MenuItem.is_active.is_(True))
    )
    return [MenuItemOut.model_validate(m) for m in result.scalars().all()]
