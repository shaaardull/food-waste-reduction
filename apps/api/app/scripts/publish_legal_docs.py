"""One-shot script to publish the current locked legal documents into
document_versions.

Runs idempotently: if the (document_type, version) row already exists,
we skip it. This lets you re-run after every text amendment; only new
versions get inserted.

Usage:
    docker compose run --rm api python -m app.scripts.publish_legal_docs

Text is loaded from the markdown files that also feed the client-side
render. Keep the on-disk file as the authoritative source; this script
only mirrors it into the DB so the signup middleware can hash-verify
and audit against a fixed row rather than a floating file.
"""
from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.consent import DOCUMENT_TYPES, DocumentVersion

settings = get_settings()

# Every published document is described by one row here. Bump `version`
# when the text changes and re-run this script; the new row will slot
# in next to the old ones.
#
# NOTE: The markdown source files ship in the repo under
# docs/legal/ so they can be published from any environment. Copy the
# finalised 08_diner_tos.md and 09_staff_tos.md from the scratchpad
# into that folder before first prod publish.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_LEGAL_DIR = _REPO_ROOT / "docs" / "legal"

VERSIONS_TO_PUBLISH: list[dict[str, str]] = [
    {
        "document_type": "diner_tos",
        "version": "1.0",
        "path": str(_LEGAL_DIR / "diner_tos_v1.0.md"),
    },
    {
        "document_type": "staff_tos",
        "version": "1.0",
        "path": str(_LEGAL_DIR / "staff_tos_v1.0.md"),
    },
    # Part B of the Diner ToS is also published as its own row so the
    # signup middleware can version-check the two checkboxes
    # independently. The content is the "PART B" section extracted from
    # diner_tos_v1.0.md; keep the extract in sync when the ToS changes.
    {
        "document_type": "research_consent",
        "version": "1.0",
        "path": str(_LEGAL_DIR / "research_consent_v1.0.md"),
    },
]


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main() -> None:
    engine = create_engine(settings.DATABASE_URL_SYNC, pool_pre_ping=True, future=True)
    with Session(engine, future=True) as db:
        published = 0
        skipped = 0
        for entry in VERSIONS_TO_PUBLISH:
            assert entry["document_type"] in DOCUMENT_TYPES, entry
            existing = db.execute(
                select(DocumentVersion).where(
                    DocumentVersion.document_type == entry["document_type"],
                    DocumentVersion.version == entry["version"],
                )
            ).scalar_one_or_none()
            if existing is not None:
                skipped += 1
                print(
                    f"skip  {entry['document_type']} v{entry['version']} "
                    f"(already published as {existing.id})"
                )
                continue

            source_path = Path(entry["path"])
            if not source_path.exists():
                raise FileNotFoundError(
                    f"Legal document source not found at {source_path}. "
                    "Copy the finalised markdown into docs/legal/ first."
                )
            content = source_path.read_text(encoding="utf-8")
            row = DocumentVersion(
                document_type=entry["document_type"],
                version=entry["version"],
                effective_from=datetime.now(UTC),
                content_markdown=content,
                content_sha256=_sha256(content),
                published_by_user_id=None,  # CLI publish, no logged-in user
            )
            db.add(row)
            db.flush()
            published += 1
            print(
                f"pub   {entry['document_type']} v{entry['version']} -> {row.id}"
            )
        db.commit()
        print(f"done: {published} published, {skipped} already present")


if __name__ == "__main__":
    main()
