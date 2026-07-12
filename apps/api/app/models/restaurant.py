from decimal import Decimal
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Float,
    ForeignKey,
    Integer,
    Numeric,
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
    # §12 multi-tenancy: each restaurant gets a slug-scoped theme on the
    # shared PWA. Hex color, optional logo / tagline.
    theme_primary_color: Mapped[str] = mapped_column(
        String, nullable=False, default="#0f766e", server_default="#0f766e"
    )
    theme_logo_url: Mapped[str | None] = mapped_column(String, nullable=True)
    tagline: Mapped[str | None] = mapped_column(String, nullable=True)
    # GST config — added in sprint Gap-D. Every bill snapshots the
    # rate at issue time, so a restaurant tweaking their rate later
    # doesn't retroactively change past bills. Default 5% matches
    # dine-in for non-hotel restaurants in India (CGST 2.5 + SGST 2.5).
    gstin: Mapped[str | None] = mapped_column(String, nullable=True)
    gst_rate: Mapped[Decimal] = mapped_column(
        Numeric(4, 3), nullable=False, default=Decimal("0.050"), server_default="0.050"
    )
    hsn_code: Mapped[str] = mapped_column(
        String, nullable=False, default="9963", server_default="9963"
    )
    bill_prefix: Mapped[str | None] = mapped_column(String, nullable=True)
    # Sprint E toggle — restaurants under the ₹20L annual turnover
    # threshold, or on composition schemes, can flip this false so bills
    # skip the CGST/SGST split. When disabled, taxable == subtotal and
    # total == subtotal (rate/amount fields all zero).
    gst_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )


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
