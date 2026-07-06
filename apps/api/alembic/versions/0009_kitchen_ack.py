"""kitchen_ack_at column on meal_sessions for the live-orders dashboard.

Gap C from the sprint kickoff: the diner can order from the table via
the PWA menu, but the kitchen never sees that order until the diner
shows up with a plate to photograph. This column powers the new
"NEW ORDERS → PREPARING" column split on the Orders dashboard.

`kitchen_ack_at IS NULL`  = kitchen hasn't marked the order as sent
`kitchen_ack_at NOT NULL` = kitchen tapped "Mark sent"

Purely cosmetic per the sprint decision — the diner flow doesn't
gate on this value. If a restaurant never uses the Orders screen,
every session simply stays with kitchen_ack_at = NULL forever and
nothing breaks.

Revision ID: 0009
Revises: 0008
Create Date: 2026-07-06
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0009"
down_revision: str | Sequence[str] | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "meal_sessions",
        sa.Column("kitchen_ack_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("meal_sessions", "kitchen_ack_at")
