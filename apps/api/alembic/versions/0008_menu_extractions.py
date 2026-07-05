"""menu_extractions audit log for the vision-based menu-card import flow.

Every "scan menu card" run on the staff dashboard persists a row here
with the raw Claude Vision tool output and how many rows the staff
actually accepted. Cheap to keep, invaluable for prompt tuning and
for debugging model regressions per restaurant.

Revision ID: 0008
Revises: 0007
Create Date: 2026-07-06
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0008"
down_revision: str | Sequence[str] | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "menu_extractions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "restaurant_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("restaurants.id"),
            nullable=False,
        ),
        sa.Column(
            "staff_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        # Source image key in S3 / MinIO. Nullable so the retention job
        # can null it out while keeping the audit row.
        sa.Column("image_s3_key", sa.String(), nullable=True),
        sa.Column("model_name", sa.String(), nullable=False),
        sa.Column("model_version", sa.String(), nullable=False),
        sa.Column(
            "raw_output", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.Column("items_proposed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("items_accepted", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("processing_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "extracted_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
    )
    op.create_index(
        "ix_menu_extractions_restaurant_id",
        "menu_extractions",
        ["restaurant_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_menu_extractions_restaurant_id", table_name="menu_extractions")
    op.drop_table("menu_extractions")
