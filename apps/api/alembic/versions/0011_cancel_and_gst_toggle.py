"""Add 'cancelled' meal-session status + gst_enabled toggle on restaurants.

Two additions, one migration because they land in the same sprint
(Gap-D follow-up).

1. `meal_sessions.status` gets a new legal value 'cancelled' — staff
   can now cancel an order at any stage. Ethics rule 9 diner-recourse
   still applies: cancellation carries a reason and the diner sees it
   on SessionStatus (columns added in 0012).

2. `restaurants.gst_enabled BOOLEAN NOT NULL DEFAULT TRUE`. When
   false, the billing service skips the CGST/SGST split — taxable
   amount == subtotal and total == subtotal. Useful for restaurants
   below the ₹20L annual turnover GST threshold, or in states with
   local composition schemes.

Revision ID: 0011
Revises: 0010
Create Date: 2026-07-07
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0011"
down_revision: str | Sequence[str] | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── Meal session status: add 'cancelled' ──
    op.drop_constraint(
        "meal_sessions_status_check", "meal_sessions", type_="check"
    )
    op.create_check_constraint(
        "meal_sessions_status_check",
        "meal_sessions",
        "status IN ('open','before_captured','eating','after_submitted','scored',"
        "'pending_staff_validation','staff_approved','staff_rejected','rewarded',"
        "'expired','disputed','cancelled')",
    )

    # ── Restaurant GST enable toggle ──
    op.add_column(
        "restaurants",
        sa.Column(
            "gst_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )


def downgrade() -> None:
    op.drop_column("restaurants", "gst_enabled")
    op.drop_constraint(
        "meal_sessions_status_check", "meal_sessions", type_="check"
    )
    op.create_check_constraint(
        "meal_sessions_status_check",
        "meal_sessions",
        "status IN ('open','before_captured','eating','after_submitted','scored',"
        "'pending_staff_validation','staff_approved','staff_rejected','rewarded',"
        "'expired','disputed')",
    )
