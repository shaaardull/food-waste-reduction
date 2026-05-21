from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPKMixin


class User(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('diner', 'staff', 'admin')", name="users_role_check"),
        # Ethics rule 6: default 7-day retention, configurable up to 90 days
        # for users who opt in to "improve the model with my plates".
        CheckConstraint(
            "image_retention_days BETWEEN 7 AND 90",
            name="users_retention_range_check",
        ),
    )

    email: Mapped[str] = mapped_column(String, unique=True, nullable=False, index=True)
    phone: Mapped[str | None] = mapped_column(String, unique=True, nullable=True, index=True)
    display_name: Mapped[str | None] = mapped_column(String, nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    role: Mapped[str] = mapped_column(String, nullable=False, default="diner")
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Per-user image retention window in days. Captures older than this are
    # purged from S3 by the daily image_retention job; 7 by default, up to 90
    # for users who opt in via PATCH /auth/me.
    image_retention_days: Mapped[int] = mapped_column(
        Integer, nullable=False, default=7, server_default="7"
    )
