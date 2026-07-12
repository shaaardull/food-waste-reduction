"""QR-token inventory table for pre-printed table stickers.

Operational model:
  1. Platform owner runs `scripts/generate_qr_batch.py --count N`.
     Rows land in `qr_tokens` with `state='unassigned'`, and a
     printable PDF pops out for the sticker press.
  2. On restaurant onboarding day, the owner (or the restaurant's
     manager on their own dashboard) scans each sticker and binds
     it to a `(restaurant_id, table_code)` pair.
  3. Diner scans the sticker → `/qr/:token` → PWA resolves the
     token to (restaurant, table) and opens a session as normal.

Fields:
  • `token` — the short URL-safe identifier printed inside the QR.
    Not derivable from restaurant_id; a diner who screenshots the
    URL can't guess the next sticker.
  • `batch_label` — free-text tag from the CLI so ops can filter by
    print run ("2026-q3-batch-A") for inventory tracking.
  • `state` — narrow enum (unassigned / assigned / retired). Retired
    lets ops mark a sticker as "damaged, printed a replacement" so
    the token is dead but the audit history stays.
  • `restaurant_id` + `table_code` populated only in state='assigned'.

Constraints:
  • FK on restaurant_id uses ON DELETE SET NULL so wiping a
    restaurant doesn't cascade-nuke the token; the sticker goes
    back to unassigned via a follow-up admin action.
  • CHECK on state IN (…) at the DB level for defence in depth.
  • Partial unique index on (restaurant_id, table_code) WHERE
    state='assigned' — one active sticker per table. If a sticker
    breaks, retire the old row before assigning a new one to the
    same table.

Revision ID: 0014
Revises: 0013
Create Date: 2026-07-09
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0014"
down_revision: str | Sequence[str] | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "qr_tokens",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("token", sa.String(length=32), unique=True, nullable=False),
        sa.Column("batch_label", sa.String(length=64), nullable=True),
        sa.Column(
            "state",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'unassigned'"),
        ),
        sa.Column(
            "restaurant_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("restaurants.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("table_code", sa.String(length=64), nullable=True),
        sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.CheckConstraint(
            "state IN ('unassigned', 'assigned', 'retired')",
            name="qr_tokens_state_check",
        ),
    )
    op.create_index(
        "ix_qr_tokens_state_created",
        "qr_tokens",
        ["state", sa.text("created_at DESC")],
    )
    op.create_index(
        "ix_qr_tokens_batch",
        "qr_tokens",
        ["batch_label"],
    )
    # Partial unique index — only assigned tokens can't collide on
    # the same (restaurant, table) pair. Retired / unassigned tokens
    # bearing the same values are fine (they represent history).
    op.execute(
        "CREATE UNIQUE INDEX ix_qr_tokens_active_binding "
        "ON qr_tokens (restaurant_id, table_code) "
        "WHERE state = 'assigned'"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_qr_tokens_active_binding")
    op.drop_index("ix_qr_tokens_batch", table_name="qr_tokens")
    op.drop_index("ix_qr_tokens_state_created", table_name="qr_tokens")
    op.drop_table("qr_tokens")
