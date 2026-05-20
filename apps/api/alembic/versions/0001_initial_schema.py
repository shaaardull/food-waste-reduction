"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-05-20
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute('CREATE EXTENSION IF NOT EXISTS "pgcrypto"')

    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("email", sa.String(), nullable=False, unique=True),
        sa.Column("phone", sa.String(), nullable=True, unique=True),
        sa.Column("display_name", sa.String(), nullable=True),
        sa.Column("password_hash", sa.String(), nullable=True),
        sa.Column("role", sa.String(), nullable=False, server_default="diner"),
        sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("role IN ('diner', 'staff', 'admin')", name="users_role_check"),
    )
    op.create_index("ix_users_email", "users", ["email"])
    op.create_index("ix_users_phone", "users", ["phone"])

    op.create_table(
        "restaurants",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("slug", sa.String(), nullable=False, unique=True),
        sa.Column("address", sa.String(), nullable=False),
        sa.Column("latitude", sa.Float(), nullable=False),
        sa.Column("longitude", sa.Float(), nullable=False),
        sa.Column("geofence_radius_m", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("timezone", sa.String(), nullable=False, server_default="UTC"),
        sa.Column("currency", sa.String(), nullable=False, server_default="INR"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_restaurants_slug", "restaurants", ["slug"])

    op.create_table(
        "restaurant_staff",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("restaurant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("restaurants.id"), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "restaurant_id", name="uq_restaurant_staff_user_restaurant"),
        sa.CheckConstraint("role IN ('owner', 'manager', 'server')", name="restaurant_staff_role_check"),
    )
    op.create_index("ix_restaurant_staff_user_id", "restaurant_staff", ["user_id"])
    op.create_index("ix_restaurant_staff_restaurant_id", "restaurant_staff", ["restaurant_id"])

    op.create_table(
        "menu_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("restaurant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("restaurants.id"), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("price_minor", sa.Integer(), nullable=False),
        sa.Column("category", sa.String(), nullable=True),
        sa.Column("is_reward_eligible", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("reference_image_url", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_menu_items_restaurant_id", "menu_items", ["restaurant_id"])

    op.create_table(
        "reward_rules",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("restaurant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("restaurants.id"), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("consumption_threshold", sa.Numeric(3, 2), nullable=False),
        sa.Column("reward_menu_item_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("menu_items.id"), nullable=False),
        sa.Column("daily_redemption_cap_per_user", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("valid_from", sa.DateTime(timezone=True), nullable=True),
        sa.Column("valid_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "consumption_threshold BETWEEN 0.50 AND 0.95",
            name="reward_rules_threshold_ethics_check",
        ),
    )
    op.create_index("ix_reward_rules_restaurant_id", "reward_rules", ["restaurant_id"])

    op.create_table(
        "meal_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("diner_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("restaurant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("restaurants.id"), nullable=False),
        sa.Column("table_code", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="open"),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("client_lat", sa.Float(), nullable=True),
        sa.Column("client_lng", sa.Float(), nullable=True),
        sa.Column("device_fingerprint", sa.String(), nullable=True),
        sa.Column("escalated", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "status IN ('open','before_captured','eating','after_submitted','scored',"
            "'pending_staff_validation','staff_approved','staff_rejected',"
            "'rewarded','expired','disputed')",
            name="meal_sessions_status_check",
        ),
    )
    op.create_index("ix_meal_sessions_diner_started", "meal_sessions", ["diner_user_id", sa.text("started_at DESC")])
    op.create_index(
        "ix_meal_sessions_restaurant_status_started",
        "meal_sessions",
        ["restaurant_id", "status", sa.text("started_at DESC")],
    )
    op.create_index(
        "ix_meal_sessions_pending_validation",
        "meal_sessions",
        ["restaurant_id", "status"],
        postgresql_where=sa.text("status = 'pending_staff_validation'"),
    )

    op.create_table(
        "meal_session_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "meal_session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("meal_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("menu_item_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("menu_items.id"), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("portion_size", sa.String(), nullable=True),
        sa.Column("notes", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "portion_size IS NULL OR portion_size IN ('small', 'regular', 'large')",
            name="meal_session_items_portion_check",
        ),
    )
    op.create_index("ix_meal_session_items_meal_session_id", "meal_session_items", ["meal_session_id"])

    op.create_table(
        "plate_captures",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "meal_session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("meal_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("phase", sa.String(), nullable=False),
        sa.Column("image_s3_key", sa.String(), nullable=False),
        sa.Column("image_sha256", sa.String(), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("client_lat", sa.Float(), nullable=True),
        sa.Column("client_lng", sa.Float(), nullable=True),
        sa.Column("device_fingerprint", sa.String(), nullable=True),
        sa.Column("nonce", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("phase IN ('before', 'after')", name="plate_captures_phase_check"),
        sa.UniqueConstraint("meal_session_id", "phase", name="uq_plate_captures_session_phase"),
    )
    op.create_index("ix_plate_captures_image_hash", "plate_captures", ["image_sha256"])

    op.create_table(
        "consumption_scores",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "meal_session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("meal_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("overall_score", sa.Numeric(4, 3), nullable=False),
        sa.Column("per_item_scores", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("model_name", sa.String(), nullable=False),
        sa.Column("model_version", sa.String(), nullable=False),
        sa.Column("processing_ms", sa.Integer(), nullable=False),
        sa.Column("raw_model_output", postgresql.JSONB(), nullable=True),
        sa.Column("notes", sa.String(), nullable=True),
        sa.Column("suspicious", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("confidence", sa.Numeric(4, 3), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("meal_session_id", name="uq_consumption_scores_session"),
    )

    op.create_table(
        "staff_validations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "meal_session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("meal_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("staff_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("restaurant_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("restaurants.id"), nullable=False),
        sa.Column("decision", sa.String(), nullable=False),
        sa.Column("model_score", sa.Numeric(4, 3), nullable=False),
        sa.Column("final_score", sa.Numeric(4, 3), nullable=False),
        sa.Column("reason_code", sa.String(), nullable=True),
        sa.Column("notes", sa.String(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("decision_latency_ms", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "decision IN ('approved', 'rejected', 'adjusted')",
            name="staff_validations_decision_check",
        ),
        sa.UniqueConstraint("meal_session_id", name="uq_staff_validations_session"),
    )
    op.create_index("ix_staff_validations_staff_user_id", "staff_validations", ["staff_user_id"])

    op.create_table(
        "rewards",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("meal_session_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("meal_sessions.id"), nullable=False),
        sa.Column("reward_rule_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("reward_rules.id"), nullable=False),
        sa.Column("redemption_code", sa.String(), nullable=False, unique=True),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("redeemed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("redeemed_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("voided_reason", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_rewards_meal_session_id", "rewards", ["meal_session_id"])
    op.create_index("ix_rewards_redemption_code", "rewards", ["redemption_code"])

    op.create_table(
        "fraud_signals",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("meal_session_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("meal_sessions.id"), nullable=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("signal_type", sa.String(), nullable=False),
        sa.Column("severity", sa.String(), nullable=False),
        sa.Column("details", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("severity IN ('info', 'warning', 'block')", name="fraud_signals_severity_check"),
    )
    op.create_index("ix_fraud_signals_meal_session_id", "fraud_signals", ["meal_session_id"])
    op.create_index("ix_fraud_signals_user_created", "fraud_signals", ["user_id", sa.text("created_at DESC")])

    op.create_table(
        "disputes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("meal_session_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("meal_sessions.id"), nullable=False),
        sa.Column("raised_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("reason", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="open"),
        sa.Column("resolved_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolution_notes", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "status IN ('open', 'resolved_in_favor_diner', 'resolved_in_favor_restaurant', 'closed')",
            name="disputes_status_check",
        ),
    )
    op.create_index("ix_disputes_meal_session_id", "disputes", ["meal_session_id"])


def downgrade() -> None:
    op.drop_table("disputes")
    op.drop_table("fraud_signals")
    op.drop_table("rewards")
    op.drop_table("staff_validations")
    op.drop_table("consumption_scores")
    op.drop_table("plate_captures")
    op.drop_table("meal_session_items")
    op.drop_table("meal_sessions")
    op.drop_table("reward_rules")
    op.drop_table("menu_items")
    op.drop_table("restaurant_staff")
    op.drop_table("restaurants")
    op.drop_table("users")
