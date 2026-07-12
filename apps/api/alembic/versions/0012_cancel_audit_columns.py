"""Add cancelled_reason + cancelled_at audit columns to meal_sessions.

Split out from 0011 (which had already been applied by the time we
realised the cancellation flow needs a durable place to store the
staff reason). Both nullable so historical sessions round-trip
unchanged — the diner-facing SessionStatus screen just doesn't render
the reason banner when it's NULL.

Ethics rule 9 diner-recourse: when a session goes to 'cancelled',
the diner is entitled to see why. Free-text `reason` lets staff
enter e.g. "kitchen ran out of paneer" rather than picking from a
fixed enum, because customer-empathy language beats a code.

Revision ID: 0012
Revises: 0011
Create Date: 2026-07-07
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0012"
down_revision: str | Sequence[str] | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "meal_sessions",
        sa.Column("cancelled_reason", sa.String(), nullable=True),
    )
    op.add_column(
        "meal_sessions",
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("meal_sessions", "cancelled_at")
    op.drop_column("meal_sessions", "cancelled_reason")
