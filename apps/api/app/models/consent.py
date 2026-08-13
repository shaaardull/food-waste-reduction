"""ORM models for the ToS + Research consent audit trail.

Both tables are append-only. Withdrawal is a new user_consents row with
action='withdrawn', not an UPDATE. A new version of a legal document is
a fresh document_versions row, not an edit. The app must never issue
UPDATE on either table; deletion is only permitted via the ON DELETE
CASCADE from users (account deletion tears out the audit trail with
the user, which is the correct behaviour under DPDP erasure).
"""
from datetime import datetime
from uuid import UUID

from sqlalchemy import CHAR, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import INET
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDPKMixin

# Kept in Python as tuples so the router / service layer can validate
# against the same source of truth as the DB CHECK constraints in
# migration 0025.
DOCUMENT_TYPES: tuple[str, ...] = (
    "diner_tos",
    "staff_tos",
    "research_consent",
    "privacy_policy",
)
CONSENT_ACTIONS: tuple[str, ...] = ("accepted", "withdrawn")
CONSENT_CONTEXTS: tuple[str, ...] = (
    "signup",
    "settings_toggle",
    "consent_refresh",
    "admin_import",
)


class DocumentVersion(Base, UUIDPKMixin):
    __tablename__ = "document_versions"
    __table_args__ = (
        UniqueConstraint("document_type", "version", name="uq_document_versions_type_version"),
    )

    document_type: Mapped[str] = mapped_column(String, nullable=False)
    version: Mapped[str] = mapped_column(String, nullable=False)
    effective_from: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    content_markdown: Mapped[str] = mapped_column(Text, nullable=False)
    # 64-char hex SHA-256 of content_markdown. A DB trigger enforces the
    # match at INSERT time (see migration 0025); this column is here for
    # fast equality lookups from the app when checking that a client
    # hasn't POSTed a stale version hash.
    content_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    published_by_user_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )


class UserConsent(Base, UUIDPKMixin):
    __tablename__ = "user_consents"

    user_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    document_version_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("document_versions.id"), nullable=False
    )
    document_type: Mapped[str] = mapped_column(String, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    ip_address: Mapped[str | None] = mapped_column(INET, nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    context: Mapped[str | None] = mapped_column(String, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
