"""labeled_sessions tracking table for the Label Studio data pipeline.

CLAUDE.md §9 Phase 2: "Data labeling pipeline (Label Studio integration)."

Tracks which meal sessions have been exported to Label Studio and when
labels were imported back. We don't store the labels themselves here —
those land in datasets/<version>/ on disk in YOLO format, ready to feed
the next fine-tuning run. This table answers: "what's in the labelling
queue", "what's been exported but not yet labelled", "what's the labelled
sample count for restaurant X".

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-22
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0007"
down_revision: str | Sequence[str] | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "labeled_sessions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "meal_session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("meal_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "exported_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "labels_imported_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        # Label Studio assigns its own task id when we POST tasks via API.
        # When we use file-based round-trip (the default in this repo), this
        # stays NULL — task id is the row's id below.
        sa.Column("label_studio_task_id", sa.Integer(), nullable=True),
        sa.Column(
            "label_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
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
        sa.UniqueConstraint("meal_session_id", name="labeled_sessions_session_unique"),
    )
    op.create_index(
        "labeled_sessions_pending_idx",
        "labeled_sessions",
        ["labels_imported_at"],
        postgresql_where=sa.text("labels_imported_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("labeled_sessions_pending_idx", table_name="labeled_sessions")
    op.drop_table("labeled_sessions")
