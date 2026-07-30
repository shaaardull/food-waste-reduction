"""Per-restaurant Kitchen Order Ticket (KOT) toggle.

Not every restaurant needs a Kitchen Display System. A small café with
a counter-side kitchen may just eyeball the Live Orders screen; a
family-run kitchen may not want paper tickets at all. Give them an
explicit opt-in and default the feature OFF so onboarding stays
opinionless.

When ``kot_enabled = false``:
  * ``app.services.kot`` no-ops all emissions — no ``kot_events`` rows,
    no chime, no auto-print.
  * The Kitchen queue endpoint returns an empty station map.
  * The dashboard hides the Kitchen nav item so nobody wanders in and
    sees a blank board.

Existing meal_session_items are unaffected — items still cook by
whatever means the restaurant uses on the Live Orders screen.

Defaulting FALSE for all rows (new and existing) matches the user's
intent: onboarding should be opt-in for KOT. Pilot restaurants that
were already using the KDS need to flip this back on in Settings.

Revision ID: 0024
Revises: 0023
Create Date: 2026-07-29
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0024"
down_revision: str | Sequence[str] | None = "0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "restaurants",
        sa.Column(
            "kot_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("restaurants", "kot_enabled")
