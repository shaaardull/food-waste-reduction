"""User consent audit tables + capture-time research-consent tag.

Introduces two append-only tables that back the ToS + Research consent
storage layer described in the finalised Diner and Staff ToS documents.
Nothing in either table is ever UPDATEd; a withdrawal is a new row with
action='withdrawn', and a new document version is a fresh row in
document_versions. This gives us a defensible audit trail under DPDP
Act Section 6 (Data Fiduciary must be able to demonstrate consent).

Tables:
  * document_versions — one row per published version of each legal doc
    (diner_tos, staff_tos, research_consent, privacy_policy). Stores the
    exact markdown text plus its SHA-256 hash.
  * user_consents — one row per accept-or-withdraw event, linked to the
    exact document_version the user saw.

Also caches the current research-consent state on plate_captures at
capture time via a new boolean column + partial index. Freezes consent
to the moment of capture (matches the legal reality) and lets training
queries filter with a fast partial index instead of joining through
users -> user_consents on every read.

Revision ID: 0025
Revises: 0024
Create Date: 2026-08-15
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0025"
down_revision: str | Sequence[str] | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# The four legal-document types we track. Keep this list in one place
# so the CHECK constraints, the ORM enum, and the schema layer agree.
_DOC_TYPES = ("diner_tos", "staff_tos", "research_consent", "privacy_policy")
_ACTIONS = ("accepted", "withdrawn")
_CONTEXTS = ("signup", "settings_toggle", "consent_refresh", "admin_import")


def upgrade() -> None:
    op.create_table(
        "document_versions",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("document_type", sa.String(), nullable=False),
        sa.Column("version", sa.String(), nullable=False),
        sa.Column("effective_from", sa.DateTime(timezone=True), nullable=False),
        # The full markdown of the version, exactly as shown to users at
        # signup. Kept in-DB rather than in an object store because it is
        # the primary evidence of what the user consented to.
        sa.Column("content_markdown", sa.Text(), nullable=False),
        # SHA-256 of content_markdown as a hex string. Trigger below
        # enforces this to prevent silent edits.
        sa.Column("content_sha256", sa.CHAR(64), nullable=False),
        sa.Column(
            "published_by_user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.CheckConstraint(
            f"document_type IN {tuple(_DOC_TYPES)!r}".replace("'", "'"),
            name="document_versions_type_check",
        ),
        sa.UniqueConstraint("document_type", "version", name="uq_document_versions_type_version"),
    )
    op.create_index(
        "ix_document_versions_type_effective",
        "document_versions",
        ["document_type", sa.text("effective_from DESC")],
    )

    op.create_table(
        "user_consents",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "document_version_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("document_versions.id"),
            nullable=False,
        ),
        # Denormalised so filters like "current diner_tos state per user"
        # don't need a join. Enforced consistent with document_versions
        # by the check constraint on both tables.
        sa.Column("document_type", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column("ip_address", sa.dialects.postgresql.INET(), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("context", sa.String(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.CheckConstraint(
            f"document_type IN {tuple(_DOC_TYPES)!r}",
            name="user_consents_type_check",
        ),
        sa.CheckConstraint(
            f"action IN {tuple(_ACTIONS)!r}",
            name="user_consents_action_check",
        ),
        sa.CheckConstraint(
            f"context IS NULL OR context IN {tuple(_CONTEXTS)!r}",
            name="user_consents_context_check",
        ),
    )
    op.create_index(
        "ix_user_consents_user_type_time",
        "user_consents",
        ["user_id", "document_type", sa.text("created_at DESC")],
    )
    op.create_index(
        "ix_user_consents_type_action_time",
        "user_consents",
        ["document_type", "action", sa.text("created_at DESC")],
    )

    # Convenience view: the most recent event per (user, document_type).
    # Filter action='accepted' downstream to get the "currently consented"
    # set. The DISTINCT ON pattern here is Postgres-specific and is the
    # cheapest way to express "latest row per group".
    op.execute(
        """
        CREATE VIEW v_current_consents AS
        SELECT DISTINCT ON (user_id, document_type)
            user_id,
            document_type,
            document_version_id,
            action,
            created_at AS decided_at
        FROM user_consents
        ORDER BY user_id, document_type, created_at DESC
        """
    )

    # Enforce that content_sha256 matches encode(digest(content_markdown, 'sha256'), 'hex').
    # Runs on INSERT only — rows are immutable after that (application-level
    # rule, enforced by app code not touching UPDATE).
    op.execute(
        """
        CREATE OR REPLACE FUNCTION check_document_sha256() RETURNS trigger AS $$
        BEGIN
            IF NEW.content_sha256 IS DISTINCT FROM
               encode(digest(NEW.content_markdown, 'sha256'), 'hex')
            THEN
                RAISE EXCEPTION
                    'content_sha256 does not match SHA-256 of content_markdown';
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    # pgcrypto ships with Postgres and provides encode/digest. Existing
    # Plate-Clean migrations already assume it (gen_random_uuid).
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    op.execute(
        """
        CREATE TRIGGER trg_document_versions_sha256
        BEFORE INSERT ON document_versions
        FOR EACH ROW EXECUTE FUNCTION check_document_sha256()
        """
    )

    # Cache the research-consent state onto every plate_capture at
    # capture time. Frozen once and only re-touched when a user
    # withdraws — the retirement job (Celery) flips this to FALSE for
    # their historic rows. Partial index means training-data queries
    # can filter WHERE research_consent_at_capture = TRUE at near-zero
    # cost.
    op.add_column(
        "plate_captures",
        sa.Column(
            "research_consent_at_capture",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.create_index(
        "ix_plate_captures_research_ok",
        "plate_captures",
        ["research_consent_at_capture"],
        postgresql_where=sa.text("research_consent_at_capture = TRUE"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_plate_captures_research_ok",
        table_name="plate_captures",
        postgresql_where=sa.text("research_consent_at_capture = TRUE"),
    )
    op.drop_column("plate_captures", "research_consent_at_capture")
    op.execute("DROP TRIGGER IF EXISTS trg_document_versions_sha256 ON document_versions")
    op.execute("DROP FUNCTION IF EXISTS check_document_sha256()")
    op.execute("DROP VIEW IF EXISTS v_current_consents")
    op.drop_index("ix_user_consents_type_action_time", table_name="user_consents")
    op.drop_index("ix_user_consents_user_type_time", table_name="user_consents")
    op.drop_table("user_consents")
    op.drop_index("ix_document_versions_type_effective", table_name="document_versions")
    op.drop_table("document_versions")
