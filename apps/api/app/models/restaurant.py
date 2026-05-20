from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin


class Restaurant(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "restaurants"

    name: Mapped[str] = mapped_column(String, nullable=False)
    slug: Mapped[str] = mapped_column(String, unique=True, nullable=False, index=True)
    address: Mapped[str] = mapped_column(String, nullable=False)
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    geofence_radius_m: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    timezone: Mapped[str] = mapped_column(String, nullable=False, default="UTC")
    currency: Mapped[str] = mapped_column(String, nullable=False, default="INR")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class RestaurantStaff(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "restaurant_staff"
    __table_args__ = (
        UniqueConstraint("user_id", "restaurant_id", name="uq_restaurant_staff_user_restaurant"),
        CheckConstraint(
            "role IN ('owner', 'manager', 'server')", name="restaurant_staff_role_check"
        ),
    )

    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    restaurant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(String, nullable=False)
