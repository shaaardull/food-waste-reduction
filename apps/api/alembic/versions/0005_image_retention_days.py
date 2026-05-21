"""users.image_retention_days for the per-user opt-in to 90-day retention

Ethics rule 6 (CLAUDE.md §8): default 7 days, configurable per user up to 90.

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-21
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: Union[str, Sequence[str], None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "image_retention_days",
            sa.Integer(),
            nullable=False,
            server_default="7",
        ),
    )
    op.create_check_constraint(
        "users_retention_range_check",
        "users",
        "image_retention_days BETWEEN 7 AND 90",
    )


def downgrade() -> None:
    op.drop_constraint("users_retention_range_check", "users", type_="check")
    op.drop_column("users", "image_retention_days")
