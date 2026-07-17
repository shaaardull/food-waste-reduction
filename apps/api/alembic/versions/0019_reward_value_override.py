"""Reward value override — configurable rupee value per reward rule.

Adds an optional `reward_rules.reward_value_minor` column so a
restaurant can decouple the reward's payout amount from the linked
menu item's price. When set, the reward-issuance path uses this
value; when NULL, it falls back to the menu item's price (existing
behavior). Historical rewards keep their `redeemed_value_minor`
snapshot untouched — the change only affects rewards minted after
the override is set.

Revision ID: 0019
Revises: 0018
Create Date: 2026-07-18
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0019"
down_revision: str | Sequence[str] | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "reward_rules",
        sa.Column("reward_value_minor", sa.Integer(), nullable=True),
    )
    op.create_check_constraint(
        "reward_rules_reward_value_minor_positive",
        "reward_rules",
        "reward_value_minor IS NULL OR reward_value_minor > 0",
    )


def downgrade() -> None:
    op.drop_constraint(
        "reward_rules_reward_value_minor_positive",
        "reward_rules",
        type_="check",
    )
    op.drop_column("reward_rules", "reward_value_minor")
