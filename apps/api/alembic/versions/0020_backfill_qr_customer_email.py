"""Backfill meal_sessions.customer_email from users.email for QR sessions.

QR-originated meal sessions carry `diner_user_id` (the signed-in diner)
but historically never wrote `customer_email` — that column was only
populated on the walk-in / takeaway Step 3 form where a staff member
types an address at the counter. As a result the Bills dashboard's
Customer column was empty for every QR row.

This one-off data migration copies the diner's account email onto
`meal_sessions.customer_email` for every QR session where:
  - `customer_email` is currently NULL (do not overwrite a staff-typed
    value)
  - `diner_user_id` is set (walk-ins have no diner and are excluded)
  - the linked user has an email (should be every user; DB has a
    NOT NULL on users.email but we guard anyway)

Downgrade: no-op. Once the values are written we can no longer
distinguish a "backfilled" NULL from an "originally-NULL and never
touched" row post-fact, so a symmetric rollback would corrupt any
staff-typed emails written after the upgrade. If a rollback is truly
needed the operator should restore from a pre-migration snapshot.

Revision ID: 0020
Revises: 0019
Create Date: 2026-07-18
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0020"
down_revision: str | Sequence[str] | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE meal_sessions
        SET customer_email = u.email
        FROM users u
        WHERE meal_sessions.diner_user_id = u.id
          AND meal_sessions.customer_email IS NULL
          AND u.email IS NOT NULL
        """
    )


def downgrade() -> None:
    # Intentionally a no-op — see module docstring.
    pass
