"""Takeaway walk-in sessions.

A takeaway is a walk-in without a physical table binding. The order
still runs through the walk-in status machine (open → serving →
served → billed → paid) and staff still bill and mark it paid the
same way; the only difference is that there's no real table code,
so the create endpoint synthesises one (TAKEAWAY-XXXXXX) so each
takeaway remains distinguishable in reports.

Revision ID: 0017
Revises: 0016
Create Date: 2026-07-17
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0017"
down_revision: str | Sequence[str] | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "meal_sessions",
        sa.Column(
            "is_takeaway",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("meal_sessions", "is_takeaway")
