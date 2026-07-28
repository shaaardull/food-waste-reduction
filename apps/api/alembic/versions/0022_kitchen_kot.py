"""Kitchen order tickets — per-item kitchen tracking and station routing.

Adds the plumbing for the KDS (Kitchen Display System) and paper KOT
printing:

  * ``menu_items.kitchen_station`` — routes each dish to its cook
    station. Defaults to ``'hot'`` so existing menus keep working
    without any per-item edit; owners can reassign in Settings → Menu.

  * ``meal_session_items.kitchen_status`` + timestamps — per-item
    lifecycle inside the kitchen (queued → fired → ready → served,
    with ``voided`` as terminal for cancelled items). Distinct from
    the coarse ``meal_sessions.kitchen_ack_at`` bit, which only tells
    the server-side "someone tapped Mark Sent"; the KDS needs
    per-item granularity so multiple stations can work independently.

  * ``kot_events`` — audit table of every KOT that was generated or
    reprinted. Snapshots the items JSON at emission time so a reprint
    two hours later can reproduce the original ticket byte-for-byte
    even if items were later voided or the diner changed their mind.
    Also drives the "auto-print on new event" behaviour on the
    kitchen tablet (subscribes to this table via the existing
    dashboard polling).

Revision ID: 0022
Revises: 0021
Create Date: 2026-07-28
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0022"
down_revision: str | Sequence[str] | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


VALID_STATIONS = "'hot','cold','bar','dessert','tandoor'"
VALID_KITCHEN_STATUSES = "'queued','fired','ready','served','voided'"
VALID_EVENT_TYPES = "'new','add_on','void','reprint'"


def upgrade() -> None:
    # --- menu_items.kitchen_station ---
    op.add_column(
        "menu_items",
        sa.Column(
            "kitchen_station",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'hot'"),
        ),
    )
    op.create_check_constraint(
        "menu_items_kitchen_station_check",
        "menu_items",
        f"kitchen_station IN ({VALID_STATIONS})",
    )

    # --- meal_session_items per-item kitchen tracking ---
    op.add_column(
        "meal_session_items",
        sa.Column(
            "kitchen_status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'queued'"),
        ),
    )
    op.add_column(
        "meal_session_items",
        sa.Column("fired_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "meal_session_items",
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_check_constraint(
        "meal_session_items_kitchen_status_check",
        "meal_session_items",
        f"kitchen_status IN ({VALID_KITCHEN_STATUSES})",
    )

    # --- kot_events audit trail ---
    op.create_table(
        "kot_events",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "meal_session_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("meal_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "restaurant_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("restaurants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("station", sa.Text(), nullable=False),
        # Frozen items list at emission time so reprints reproduce the
        # original ticket. Shape:
        #   [{"item_id":"...", "menu_item_id":"...", "name":"...",
        #     "quantity":2, "portion_size":"small",
        #     "notes":"less sugar"}]
        sa.Column(
            "items_snapshot",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
        ),
        sa.Column(
            "triggered_by_user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.CheckConstraint(
            f"event_type IN ({VALID_EVENT_TYPES})",
            name="kot_events_event_type_check",
        ),
        sa.CheckConstraint(
            f"station IN ({VALID_STATIONS})",
            name="kot_events_station_check",
        ),
    )
    # Hot path: the KDS/auto-print poll asks "any new events for my
    # restaurant since timestamp X" — this index makes that O(log n).
    op.create_index(
        "ix_kot_events_restaurant_created",
        "kot_events",
        ["restaurant_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_kot_events_restaurant_created", table_name="kot_events")
    op.drop_table("kot_events")
    op.drop_constraint(
        "meal_session_items_kitchen_status_check",
        "meal_session_items",
        type_="check",
    )
    op.drop_column("meal_session_items", "ready_at")
    op.drop_column("meal_session_items", "fired_at")
    op.drop_column("meal_session_items", "kitchen_status")
    op.drop_constraint(
        "menu_items_kitchen_station_check",
        "menu_items",
        type_="check",
    )
    op.drop_column("menu_items", "kitchen_station")
