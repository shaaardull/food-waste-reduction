"""reward_type, value, and 15/30-day windows

Implements the Phase 1 §12 reward decisions (commit message has the full
reasoning): diner picks menu_item or bill_discount; full value within 15
days of issue, half value days 16-30, expired after.

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-21
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: Union[str, Sequence[str], None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # reward_rules: allowed reward types + optional bill-discount value.
    op.add_column(
        "reward_rules",
        sa.Column(
            "allowed_reward_types",
            postgresql.ARRAY(sa.String()),
            nullable=False,
            server_default="{menu_item,bill_discount}",
        ),
    )
    op.add_column(
        "reward_rules",
        sa.Column("bill_discount_minor", sa.Integer(), nullable=True),
    )

    # rewards: type, value, half-value timestamp, redeemed value.
    op.add_column(
        "rewards",
        sa.Column(
            "reward_type",
            sa.String(),
            nullable=False,
            server_default="menu_item",
        ),
    )
    op.add_column(
        "rewards",
        sa.Column(
            "value_minor", sa.Integer(), nullable=False, server_default="0"
        ),
    )
    # NOT NULL with a sane default for the existing rows: half_value_at =
    # issued_at + 15 days. We use a server-side UPDATE then add the column
    # as NOT NULL by setting a temporary default and clearing it.
    op.add_column(
        "rewards",
        sa.Column("half_value_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        "UPDATE rewards SET half_value_at = issued_at + interval '15 days' "
        "WHERE half_value_at IS NULL"
    )
    op.alter_column("rewards", "half_value_at", nullable=False)
    op.add_column(
        "rewards",
        sa.Column("redeemed_value_minor", sa.Integer(), nullable=True),
    )

    op.create_check_constraint(
        "rewards_type_check",
        "rewards",
        "reward_type IN ('menu_item', 'bill_discount')",
    )

    # Pre-existing reward rows had a 24h window. Stretch them to 30 days so
    # the new logic doesn't immediately expire historic test rewards.
    op.execute(
        "UPDATE rewards SET expires_at = issued_at + interval '30 days' "
        "WHERE expires_at < issued_at + interval '30 days'"
    )


def downgrade() -> None:
    op.drop_constraint("rewards_type_check", "rewards", type_="check")
    op.drop_column("rewards", "redeemed_value_minor")
    op.drop_column("rewards", "half_value_at")
    op.drop_column("rewards", "value_minor")
    op.drop_column("rewards", "reward_type")
    op.drop_column("reward_rules", "bill_discount_minor")
    op.drop_column("reward_rules", "allowed_reward_types")
