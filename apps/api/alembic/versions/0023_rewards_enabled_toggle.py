"""Per-restaurant rewards-program toggle.

A restaurant may want to temporarily pause its rewards program without
tearing down its reward rules (dish shortages, seasonal changes, cost
control, or just testing the waters). ``restaurants.rewards_enabled``
is the single flag the diner PWA reads to decide whether to show the
"rewards paused" notice on the menu screen and whether to gate the
after-capture flow.

Defaults to TRUE for existing rows so live pilot restaurants continue
issuing rewards without a code change. Owners can flip it off from
Settings.

Revision ID: 0023
Revises: 0022
Create Date: 2026-07-29
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0023"
down_revision: str | Sequence[str] | None = "0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "restaurants",
        sa.Column(
            "rewards_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )


def downgrade() -> None:
    op.drop_column("restaurants", "rewards_enabled")
