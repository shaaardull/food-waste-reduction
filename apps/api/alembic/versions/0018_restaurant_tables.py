"""Restaurant tables — self-serve dining-table registry per restaurant.

Owners/managers now curate their own dining tables from the dashboard
instead of asking platform admin to bind pre-printed QR stickers. A
row here is the source of truth for what the walk-in Step 1 grid
renders; it can optionally point at a qr_tokens row that was minted
for it, so "add table" and "print sticker" can happen in one action.

Fields:
  • `table_code` — human label ("T-01"), unique per restaurant among
    active rows only (partial unique index). Historical meal_sessions
    keep their own table_code string and are unaffected by rename or
    soft-delete of a row here.
  • `qr_token_id` — optional pointer at the qr_tokens row minted for
    this table. ON DELETE SET NULL so wiping a token doesn't cascade
    into the table registry.
  • `is_active` — soft delete. Renamed/deleted rows keep history for
    the "Recently removed → Restore" affordance in the dashboard.
  • `display_order` — stable UI ordering for the tables grid; the
    router bumps it to max+1 on add.

Data migration: after CREATE TABLE, seed T-01..T-08 for every active
restaurant so pilot venues (Spice Trail, Konkan Kitchen) have a
usable default without any manual click. Backfilled rows do NOT get
a qr_token — owners generate one from the dashboard's regenerate-QR
action.

Revision ID: 0018
Revises: 0017
Create Date: 2026-07-17
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0018"
down_revision: str | Sequence[str] | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "restaurant_tables",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "restaurant_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("restaurants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("table_code", sa.String(length=64), nullable=False),
        sa.Column(
            "seat_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("4"),
        ),
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "qr_token_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("qr_tokens.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "display_order",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("notes", sa.Text(), nullable=True),
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
    )
    op.create_index(
        "ix_restaurant_tables_restaurant_active",
        "restaurant_tables",
        ["restaurant_id", "is_active", "display_order"],
    )
    # Partial unique — only active rows collide on the same code, so a
    # soft-deleted "T-05" doesn't block a fresh "T-05" from being added.
    op.execute(
        "CREATE UNIQUE INDEX ix_restaurant_tables_active_code "
        "ON restaurant_tables (restaurant_id, table_code) "
        "WHERE is_active"
    )

    # Backfill T-01..T-08 for every active restaurant. Python-side loop
    # so we don't hard-code UUIDs — the seed script's restaurants get
    # covered on any fresh DB, and any restaurant created before this
    # migration gets a sensible default too.
    conn = op.get_bind()
    result = conn.execute(sa.text("SELECT id FROM restaurants WHERE is_active"))
    for row in result.fetchall():
        for i in range(1, 9):
            code = f"T-{i:02d}"
            conn.execute(
                sa.text(
                    "INSERT INTO restaurant_tables "
                    "(restaurant_id, table_code, seat_count, display_order) "
                    "VALUES (:rid, :code, 4, :order)"
                ),
                {"rid": row.id, "code": code, "order": i},
            )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_restaurant_tables_active_code")
    op.drop_index(
        "ix_restaurant_tables_restaurant_active",
        table_name="restaurant_tables",
    )
    op.drop_table("restaurant_tables")
