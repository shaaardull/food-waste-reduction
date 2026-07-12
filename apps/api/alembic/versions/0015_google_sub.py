"""Add google_sub column to users for Google-native sign-in.

Google's `sub` claim is the stable per-user identifier — the email
can change (Google Workspace admins can rename accounts), but `sub`
never does. We key on `sub` for lookup and use email only for
display + linking to a pre-existing password account.

Nullable + unique so:
  • pre-existing password-only accounts stay valid (NULL sub)
  • two Google accounts can't share the same sub (integrity)
  • the linking flow works: password user signs in with Google whose
    email matches → we set their sub to the Google sub; from then on
    they can auth either way.

Length 64: Google's sub is a 21-digit integer string today, but the
spec allows up to 255. 64 covers current + generous future headroom
without wasting space.

Revision ID: 0015
Revises: 0014
Create Date: 2026-07-10
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0015"
down_revision: str | Sequence[str] | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("google_sub", sa.String(length=64), nullable=True),
    )
    # Partial unique index — two rows can share NULL (Postgres treats
    # NULLs as distinct in unique constraints anyway, but making it
    # partial is more explicit + slightly smaller).
    op.execute(
        "CREATE UNIQUE INDEX ix_users_google_sub_unique "
        "ON users (google_sub) WHERE google_sub IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_users_google_sub_unique")
    op.drop_column("users", "google_sub")
