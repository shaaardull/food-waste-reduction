"""restaurant theme + tagline

Phase 1 §12 multi-tenancy decision: single PWA, restaurants get slug-scoped
theming. Stores a hex primary color, an optional logo URL, and an optional
tagline.

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-21
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, Sequence[str], None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "restaurants",
        sa.Column(
            "theme_primary_color",
            sa.String(),
            nullable=False,
            server_default="#0f766e",
        ),
    )
    op.add_column(
        "restaurants",
        sa.Column("theme_logo_url", sa.String(), nullable=True),
    )
    op.add_column(
        "restaurants",
        sa.Column("tagline", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("restaurants", "tagline")
    op.drop_column("restaurants", "theme_logo_url")
    op.drop_column("restaurants", "theme_primary_color")
