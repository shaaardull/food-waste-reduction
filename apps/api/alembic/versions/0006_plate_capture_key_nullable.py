"""plate_captures.image_s3_key nullable after retention purge

Ethics rule 6 says to "purge expired image objects from S3 and clear the
image_s3_key field" — the column needs to be nullable for the daily
purge job to record that the S3 object is gone.

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-21
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: Union[str, Sequence[str], None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("plate_captures", "image_s3_key", existing_type=sa.String(), nullable=True)


def downgrade() -> None:
    # Note: if any purged rows exist (image_s3_key IS NULL) this will fail.
    # In dev / staging, drop those rows first.
    op.alter_column("plate_captures", "image_s3_key", existing_type=sa.String(), nullable=False)
