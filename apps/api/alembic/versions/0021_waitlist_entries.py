"""Waitlist entries — walk-in queue at the door.

Small cafés on the pilot wanted a way to hold a walk-in group when
every table is occupied. A distinct per-restaurant QR near the
entrance (different from the table QRs) points diners at
``/wait/{slug}``, they submit party size + name, and the staff
dashboard shows an oldest-first queue with a "Seat next" action.

No automated notification in this pass — pilot staff physically call
guests over. TODO in the seat endpoint marks the future notification
hook.

Fields:
  • ``party_size`` — CHECK 1..20 mirrors the walk-in Step 1 grid cap.
  • ``guest_name`` — required per product spec; guests need something
    to be called by.
  • ``guest_email`` / ``guest_phone`` — both optional. Phone is not
    used for auto-notify here but captured so pilot staff can dial.
  • ``status`` — lifecycle waiting → seated | cancelled | no_show.
    Terminal transitions record ``seated_by_user_id`` /
    ``cancelled_reason`` for audit + per-staff metrics later.

Index ``ix_waitlist_restaurant_status_created`` covers the staff
dashboard's hot path: "waiting entries for my restaurant, oldest
first".

Revision ID: 0021
Revises: 0020
Create Date: 2026-07-19
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0021"
down_revision: str | Sequence[str] | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "waitlist_entries",
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
        sa.Column("party_size", sa.Integer(), nullable=False),
        sa.Column("guest_name", sa.Text(), nullable=False),
        sa.Column("guest_email", sa.Text(), nullable=True),
        sa.Column("guest_phone", sa.Text(), nullable=True),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'waiting'"),
        ),
        sa.Column(
            "seated_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "seated_by_user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "cancelled_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column("cancelled_reason", sa.Text(), nullable=True),
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
        sa.CheckConstraint(
            "party_size BETWEEN 1 AND 20",
            name="waitlist_entries_party_size_check",
        ),
        sa.CheckConstraint(
            "status IN ('waiting', 'seated', 'cancelled', 'no_show')",
            name="waitlist_entries_status_check",
        ),
    )
    op.create_index(
        "ix_waitlist_restaurant_status_created",
        "waitlist_entries",
        ["restaurant_id", "status", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_waitlist_restaurant_status_created",
        table_name="waitlist_entries",
    )
    op.drop_table("waitlist_entries")
