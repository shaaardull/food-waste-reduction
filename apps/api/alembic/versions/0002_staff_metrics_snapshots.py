"""staff_metrics_snapshots

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-21
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: Union[str, Sequence[str], None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "staff_metrics_snapshots",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "staff_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "restaurant_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("restaurants.id"),
            nullable=False,
        ),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("validations_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("approvals_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rejections_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("adjustments_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rejection_rate", sa.Numeric(5, 4), nullable=False, server_default="0"),
        sa.Column("approval_rate", sa.Numeric(5, 4), nullable=False, server_default="0"),
        sa.Column(
            "restaurant_median_rejection_rate",
            sa.Numeric(5, 4),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint(
            "staff_user_id", "period_start", name="uq_staff_metrics_user_period"
        ),
    )
    op.create_index(
        "ix_staff_metrics_snapshots_staff_user_id", "staff_metrics_snapshots", ["staff_user_id"]
    )
    op.create_index(
        "ix_staff_metrics_snapshots_restaurant_id", "staff_metrics_snapshots", ["restaurant_id"]
    )


def downgrade() -> None:
    op.drop_index(
        "ix_staff_metrics_snapshots_restaurant_id", table_name="staff_metrics_snapshots"
    )
    op.drop_index(
        "ix_staff_metrics_snapshots_staff_user_id", table_name="staff_metrics_snapshots"
    )
    op.drop_table("staff_metrics_snapshots")
