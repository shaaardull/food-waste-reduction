"""Bug reports table — restaurant staff file, platform owner triages.

A single lightweight table for staff-reported issues. Kept flat (no
comment thread, no attachments) because the platform-owner review UI
is a single-editable-card layout; anything more expressive would
demand a taxonomy page nobody wants to maintain in the pilot.

Fields:
- restaurant_id nullable so admin-role users (who have no restaurant
  binding) can file from the platform-owner side. Also nullable so a
  bug orphaned by a deleted restaurant doesn't cascade-delete.
- reported_by_user_id NOT NULL — every report needs an author for the
  audit trail (ethics rule 8-adjacent — accountability of feedback).
- severity + status use narrow enums enforced via CHECK constraints
  so the admin UI can render fixed chips without a lookup table.
- admin_notes free-text — the platform owner scribbles a triage
  answer or reproduction step so the next teammate can pick it up.

Indexes: status + created_at DESC for the "open first, newest first"
list view, restaurant_id for per-restaurant filtering in the
analytics drill-down.

Revision ID: 0013
Revises: 0012
Create Date: 2026-07-08
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0013"
down_revision: str | Sequence[str] | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "bug_reports",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "restaurant_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("restaurants.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "reported_by_user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("severity", sa.String(length=16), nullable=False),
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'open'"),
        ),
        sa.Column("admin_notes", sa.Text(), nullable=True),
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
            "severity IN ('low', 'medium', 'high', 'critical')",
            name="bug_reports_severity_check",
        ),
        sa.CheckConstraint(
            "status IN ('open', 'triaging', 'in_progress', 'resolved', 'wont_fix')",
            name="bug_reports_status_check",
        ),
    )
    op.create_index(
        "ix_bug_reports_status_created",
        "bug_reports",
        ["status", sa.text("created_at DESC")],
    )
    op.create_index(
        "ix_bug_reports_restaurant",
        "bug_reports",
        ["restaurant_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_bug_reports_restaurant", table_name="bug_reports")
    op.drop_index("ix_bug_reports_status_created", table_name="bug_reports")
    op.drop_table("bug_reports")
