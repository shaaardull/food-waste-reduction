"""Walk-in orders — staff-entered sessions with no diner account.

Adds a second entry channel to meal_sessions. Walk-ins bypass the
diner PWA, QR scan, capture flow, and reward machinery entirely —
they exist only so staff can bill the table and mark it paid.

Columns added
    entry_channel        TEXT NOT NULL DEFAULT 'qr' — 'qr' | 'walkin'
    customer_email       TEXT NULL — optional paperless-bill delivery
    customer_phone       TEXT NULL — same, for SMS
    voided_at            TIMESTAMPTZ NULL
    voided_reason        TEXT NULL
    voided_by_user_id    UUID NULL REFERENCES users(id)
    paid_at              TIMESTAMPTZ NULL — walk-in "mark paid" audit

Columns altered
    diner_user_id        NOT NULL → NULL — walk-ins carry no diner

Status CHECK extended with 'voided' so the void endpoint can move a
session into that terminal state without violating the existing
constraint.

Revision ID: 0016
Revises: 0015
Create Date: 2026-07-14
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0016"
down_revision: str | Sequence[str] | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── entry_channel: 'qr' (default) or 'walkin' ─────────────────────
    op.add_column(
        "meal_sessions",
        sa.Column(
            "entry_channel",
            sa.String(),
            nullable=False,
            server_default=sa.text("'qr'"),
        ),
    )
    op.create_check_constraint(
        "meal_sessions_entry_channel_check",
        "meal_sessions",
        "entry_channel IN ('qr','walkin')",
    )

    # ── diner_user_id nullable — walk-ins have no diner account ──────
    op.alter_column(
        "meal_sessions", "diner_user_id", existing_type=sa.dialects.postgresql.UUID(), nullable=True
    )

    # ── Optional walk-in contact details for paperless bill ──────────
    op.add_column(
        "meal_sessions",
        sa.Column("customer_email", sa.String(), nullable=True),
    )
    op.add_column(
        "meal_sessions",
        sa.Column("customer_phone", sa.String(), nullable=True),
    )

    # ── Void audit trail ─────────────────────────────────────────────
    op.add_column(
        "meal_sessions",
        sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "meal_sessions",
        sa.Column("voided_reason", sa.String(), nullable=True),
    )
    op.add_column(
        "meal_sessions",
        sa.Column(
            "voided_by_user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
    )

    # ── Mark-paid audit (walk-in only) ───────────────────────────────
    op.add_column(
        "meal_sessions",
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
    )

    # ── Extend status CHECK with 'voided' and 'paid' terminal states ─
    op.drop_constraint("meal_sessions_status_check", "meal_sessions", type_="check")
    op.create_check_constraint(
        "meal_sessions_status_check",
        "meal_sessions",
        "status IN ('open','before_captured','eating','after_submitted','scored',"
        "'pending_staff_validation','staff_approved','staff_rejected','rewarded',"
        "'expired','disputed','cancelled','voided','serving','served','billed',"
        "'paid')",
    )


def downgrade() -> None:
    # Revert status CHECK first — dropping columns that constraints
    # might reference otherwise complicates the drop order.
    op.drop_constraint("meal_sessions_status_check", "meal_sessions", type_="check")
    op.create_check_constraint(
        "meal_sessions_status_check",
        "meal_sessions",
        "status IN ('open','before_captured','eating','after_submitted','scored',"
        "'pending_staff_validation','staff_approved','staff_rejected','rewarded',"
        "'expired','disputed','cancelled')",
    )

    op.drop_column("meal_sessions", "paid_at")
    op.drop_column("meal_sessions", "voided_by_user_id")
    op.drop_column("meal_sessions", "voided_reason")
    op.drop_column("meal_sessions", "voided_at")
    op.drop_column("meal_sessions", "customer_phone")
    op.drop_column("meal_sessions", "customer_email")

    op.alter_column(
        "meal_sessions", "diner_user_id", existing_type=sa.dialects.postgresql.UUID(), nullable=False
    )

    op.drop_constraint(
        "meal_sessions_entry_channel_check", "meal_sessions", type_="check"
    )
    op.drop_column("meal_sessions", "entry_channel")
