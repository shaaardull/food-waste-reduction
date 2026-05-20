from datetime import datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, Numeric, String
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin

REWARD_TYPES = ("menu_item", "bill_discount")
DEFAULT_ALLOWED_REWARD_TYPES = ["menu_item", "bill_discount"]


class RewardRule(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "reward_rules"
    __table_args__ = (
        CheckConstraint(
            "consumption_threshold BETWEEN 0.50 AND 0.95",
            name="reward_rules_threshold_ethics_check",
        ),
    )

    restaurant_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    consumption_threshold: Mapped[Decimal] = mapped_column(Numeric(3, 2), nullable=False)
    reward_menu_item_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("menu_items.id"), nullable=False
    )
    daily_redemption_cap_per_user: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    valid_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    valid_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Phase 1 §12 decision: diner picks between menu item OR bill discount at claim time.
    # PostgreSQL array — stored as TEXT[] in the migration.
    allowed_reward_types: Mapped[list[str]] = mapped_column(
        ARRAY(String),
        nullable=False,
        default=lambda: list(DEFAULT_ALLOWED_REWARD_TYPES),
        server_default="{menu_item,bill_discount}",
    )
    # When type=bill_discount, this is the discount value applied to the next bill at the
    # same restaurant. Null means "match the menu item's price".
    bill_discount_minor: Mapped[int | None] = mapped_column(Integer, nullable=True)


class Reward(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "rewards"
    __table_args__ = (
        CheckConstraint(
            "reward_type IN ('menu_item', 'bill_discount')",
            name="rewards_type_check",
        ),
    )

    meal_session_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("meal_sessions.id"), nullable=False, index=True
    )
    reward_rule_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("reward_rules.id"), nullable=False
    )
    redemption_code: Mapped[str] = mapped_column(String, unique=True, nullable=False, index=True)
    # Diner-facing choice. Defaults to 'menu_item'; staff or diner can swap to
    # 'bill_discount' before redemption via /rewards/:code/choose-type.
    reward_type: Mapped[str] = mapped_column(
        String, nullable=False, default="menu_item", server_default="menu_item"
    )
    # Base value at issuance. For menu_item: the dish's price_minor. For bill_discount:
    # the rule's bill_discount_minor (or fallback). Stored at issuance so a later
    # price change doesn't retroactively shrink past rewards.
    value_minor: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    issued_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    # New §12 decision: full value if redeemed before this; half value if redeemed
    # between this and expires_at; nothing after expires_at.
    half_value_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    redeemed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    redeemed_value_minor: Mapped[int | None] = mapped_column(Integer, nullable=True)
    redeemed_by_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    voided_reason: Mapped[str | None] = mapped_column(String, nullable=True)
