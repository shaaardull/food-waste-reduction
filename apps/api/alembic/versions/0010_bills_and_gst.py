"""bills table + per-restaurant GST config.

Sprint Gap-D (billing): every meal-session snapshots into a bill row
with a per-restaurant sequenced bill_number, GST split as CGST + SGST
(intra-state — Mumbai pilot), and reward-discount applied before tax.
Bills are informational per §12 (no payment integration in Phase 1);
this table is the source of truth for what the diner receives via
email / SMS.

Restaurant GST config lives on the restaurants row so each tenant can
configure their own rate (default 5% for non-hotel dine-in; hotels
inside 5-star tariff bracket override to 18%).

Revision ID: 0010
Revises: 0009
Create Date: 2026-07-06
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0010"
down_revision: str | Sequence[str] | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── Restaurant GST config ───────────────────────────────────────
    op.add_column("restaurants", sa.Column("gstin", sa.String(), nullable=True))
    op.add_column(
        "restaurants",
        sa.Column(
            "gst_rate",
            sa.Numeric(precision=4, scale=3),
            nullable=False,
            server_default=sa.text("0.05"),
        ),
    )
    op.add_column(
        "restaurants",
        sa.Column(
            "hsn_code",
            sa.String(),
            nullable=False,
            server_default=sa.text("'9963'"),
        ),
    )
    op.add_column(
        "restaurants", sa.Column("bill_prefix", sa.String(), nullable=True)
    )

    # ── Bills ───────────────────────────────────────────────────────
    op.create_table(
        "bills",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        # One bill per session — the UNIQUE below is what makes
        # POST /sessions/:id/bill idempotent.
        sa.Column(
            "meal_session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("meal_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "restaurant_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("restaurants.id"),
            nullable=False,
        ),
        # Human-readable, restaurant-scoped sequence. Format is
        # `<bill_prefix><yyyy>/<5-digit-seq>` when a prefix is set,
        # or `<yyyy>/<5-digit-seq>` otherwise. UNIQUE per restaurant.
        sa.Column("bill_number", sa.String(), nullable=False),
        # All money in paise (minor units) per CLAUDE.md §0.
        sa.Column("subtotal_minor", sa.Integer(), nullable=False),
        sa.Column(
            "discount_minor", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        # If the diner had an issued reward at bill time, snapshot the
        # code used to compute the discount.
        sa.Column("reward_redemption_code", sa.String(), nullable=True),
        sa.Column("taxable_amount_minor", sa.Integer(), nullable=False),
        # Rate snapshot at issue time — restaurant may change their
        # rate later, but the bill stays consistent.
        sa.Column("cgst_rate", sa.Numeric(precision=4, scale=3), nullable=False),
        sa.Column("sgst_rate", sa.Numeric(precision=4, scale=3), nullable=False),
        sa.Column("cgst_amount_minor", sa.Integer(), nullable=False),
        sa.Column("sgst_amount_minor", sa.Integer(), nullable=False),
        sa.Column("total_minor", sa.Integer(), nullable=False),
        sa.Column(
            "currency", sa.String(), nullable=False, server_default=sa.text("'INR'")
        ),
        # Frozen list of items — `[{name, quantity, price_minor,
        # portion_size, line_total_minor}]`. Immutable once written.
        sa.Column(
            "line_items_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        # Delivery target snapshots. Diner can supply either or both;
        # we mirror them here so the audit trail persists even if the
        # diner later deletes their profile.
        sa.Column("delivery_email", sa.String(), nullable=True),
        sa.Column("delivery_phone", sa.String(), nullable=True),
        sa.Column("delivered_via", sa.String(), nullable=True),
        sa.Column(
            "delivery_status",
            sa.String(),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column("delivery_error", sa.String(), nullable=True),
        sa.Column(
            "issued_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.UniqueConstraint(
            "meal_session_id", name="uq_bills_meal_session"
        ),
        sa.UniqueConstraint(
            "restaurant_id", "bill_number", name="uq_bills_restaurant_number"
        ),
        sa.CheckConstraint(
            "delivery_status IN ('pending', 'sent', 'failed')",
            name="ck_bills_delivery_status",
        ),
        sa.CheckConstraint(
            "delivered_via IS NULL OR delivered_via IN ('email', 'sms', 'both')",
            name="ck_bills_delivered_via",
        ),
    )
    op.create_index(
        "ix_bills_restaurant_id", "bills", ["restaurant_id"]
    )
    op.create_index("ix_bills_meal_session_id", "bills", ["meal_session_id"])


def downgrade() -> None:
    op.drop_index("ix_bills_meal_session_id", table_name="bills")
    op.drop_index("ix_bills_restaurant_id", table_name="bills")
    op.drop_table("bills")
    op.drop_column("restaurants", "bill_prefix")
    op.drop_column("restaurants", "hsn_code")
    op.drop_column("restaurants", "gst_rate")
    op.drop_column("restaurants", "gstin")
