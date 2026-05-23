"""Export staff-approved meal sessions to a Label Studio import JSON file.

CLAUDE.md §9 Phase 2: Data labelling pipeline. This is the first half of
the round-trip:

    [running app] ──export──► [LS JSON] ──upload to LS──► [human labels]
                                                                │
                                                                ▼
                                                          [LS JSON export]
                                                                │
                                          import_labels_from_ls │
                                                                ▼
                                                       datasets/v1/ (YOLO)

What we export
- Sessions whose status is one of: staff_approved, rewarded.
- Only those whose before AND after PlateCapture rows still have a
  non-null image_s3_key (the image-retention purge clears these after
  the user's configured window; we can't label what we've deleted).
- Only StaffValidations whose decision is in ('approved', 'adjusted')
  — rejected sessions tell us something but they're a different
  training-set use case.
- Optionally filtered by --since / --restaurant-slug / --max.
- Sessions already in labeled_sessions are skipped (idempotent — safe
  to re-run after a partial labelling pass).

For each chosen session we:
1. Generate 15-min signed S3 URLs for before + after (long enough that
   you can upload the whole file to LS before any expire).
2. Insert a labeled_sessions row so we don't re-export it.
3. Emit one task in the LS task JSON shape (matches the Label Studio
   labelling config in services/vision/labeling/config.xml).

Run:
    python -m app.scripts.export_to_label_studio \\
        --since 2026-05-01 \\
        --output /tmp/ls-tasks.json

The output file is what you upload to Label Studio's "Import" UI.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, aliased

from app.config import get_settings
from app.models.labeled_session import LabeledSession
from app.models.meal_session import MealSession, MealSessionItem
from app.models.menu_item import MenuItem
from app.models.plate_capture import PlateCapture
from app.models.restaurant import Restaurant
from app.models.staff_validation import StaffValidation
from app.services import storage

# Long enough that a slow upload to LS doesn't have URLs expire mid-flight
# but short enough that an accidental leak loses value quickly.
SIGNED_URL_TTL_SECONDS = 15 * 60

# Statuses we accept by default. Add 'staff_approved' so we also pull in
# sessions that were approved but came in under the reward threshold —
# those are still labelled food and just as valuable for training.
DEFAULT_STATUSES = ("staff_approved", "rewarded")


def _eligible_sessions(
    db: Session,
    *,
    since: datetime | None,
    statuses: tuple[str, ...],
    restaurant_slug: str | None,
    limit: int,
) -> list[tuple[MealSession, Restaurant, PlateCapture, PlateCapture, StaffValidation]]:
    """Return (session, restaurant, before_capture, after_capture, validation)
    rows for sessions that pass every filter and haven't been exported yet.
    """
    before = aliased(PlateCapture, name="before")
    after = aliased(PlateCapture, name="after")

    q = (
        select(MealSession, Restaurant, before, after, StaffValidation)
        .join(Restaurant, Restaurant.id == MealSession.restaurant_id)
        .join(
            before,
            (before.meal_session_id == MealSession.id) & (before.phase == "before"),
        )
        .join(
            after,
            (after.meal_session_id == MealSession.id) & (after.phase == "after"),
        )
        .join(StaffValidation, StaffValidation.meal_session_id == MealSession.id)
        .outerjoin(
            LabeledSession, LabeledSession.meal_session_id == MealSession.id
        )
        .where(
            LabeledSession.id.is_(None),
            before.image_s3_key.is_not(None),
            after.image_s3_key.is_not(None),
            MealSession.status.in_(statuses),
            StaffValidation.decision.in_(("approved", "adjusted")),
        )
        .order_by(MealSession.started_at.desc())
        .limit(limit)
    )
    if since is not None:
        q = q.where(MealSession.started_at >= since)
    if restaurant_slug:
        q = q.where(Restaurant.slug == restaurant_slug)

    return list(db.execute(q).all())


def _dishes_for_session(db: Session, session_id: UUID) -> list[dict[str, Any]]:
    """Pull (name, category, quantity) for each ordered item — labellers
    use this as a hint so they know what dishes to expect in the photos.
    """
    rows = db.execute(
        select(MenuItem.name, MenuItem.category, MealSessionItem.quantity)
        .join(MealSessionItem, MealSessionItem.menu_item_id == MenuItem.id)
        .where(MealSessionItem.meal_session_id == session_id)
    ).all()
    return [
        {"name": name, "category": category, "quantity": int(qty)}
        for name, category, qty in rows
    ]


def _build_task(
    session: MealSession,
    restaurant: Restaurant,
    before_key: str,
    after_key: str,
    validation: StaffValidation,
    dishes: list[dict[str, Any]],
) -> dict[str, Any]:
    """The shape Label Studio expects in its task-import JSON. The keys
    inside `data` are matched against $variables in the labelling
    config XML (services/vision/labeling/config.xml).
    """
    return {
        "data": {
            "image_before": storage.signed_url(before_key, SIGNED_URL_TTL_SECONDS),
            "image_after": storage.signed_url(after_key, SIGNED_URL_TTL_SECONDS),
            "session_id": str(session.id),
            "restaurant": restaurant.name,
            "restaurant_slug": restaurant.slug,
            "table_code": session.table_code,
            "started_at": session.started_at.isoformat(),
            "staff_final_score": float(validation.final_score),
            "dishes_summary": ", ".join(
                f"{d['quantity']}× {d['name']}" for d in dishes
            )
            or "(none recorded)",
            "dishes": dishes,
        }
    }


def export(
    db: Session,
    *,
    since: datetime | None,
    statuses: tuple[str, ...],
    restaurant_slug: str | None,
    limit: int,
    output: Path,
    dry_run: bool = False,
) -> list[dict[str, Any]]:
    """Drive the export. Returns the list of task dicts we wrote (or
    would have written, if dry_run=True). Idempotent: re-running picks
    up only sessions that weren't already in labeled_sessions.
    """
    rows = _eligible_sessions(
        db,
        since=since,
        statuses=statuses,
        restaurant_slug=restaurant_slug,
        limit=limit,
    )
    tasks: list[dict[str, Any]] = []
    now = datetime.now(UTC)
    for session, restaurant, before_cap, after_cap, validation in rows:
        dishes = _dishes_for_session(db, session.id)
        task = _build_task(
            session=session,
            restaurant=restaurant,
            before_key=before_cap.image_s3_key,
            after_key=after_cap.image_s3_key,
            validation=validation,
            dishes=dishes,
        )
        tasks.append(task)
        if not dry_run:
            db.add(
                LabeledSession(
                    meal_session_id=session.id,
                    exported_at=now,
                )
            )

    if not dry_run:
        db.commit()
        output.write_text(json.dumps(tasks, indent=2, ensure_ascii=False))

    return tasks


def _parse_date(value: str) -> datetime:
    """Accept YYYY-MM-DD or full ISO 8601. UTC-naïve inputs are pinned to UTC."""
    try:
        dt = datetime.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"--since must be YYYY-MM-DD or ISO 8601, got {value!r}"
        ) from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


def _parse_statuses(value: str) -> tuple[str, ...]:
    parts = tuple(s.strip() for s in value.split(",") if s.strip())
    if not parts:
        raise argparse.ArgumentTypeError("--status requires at least one status")
    valid = {
        "staff_approved",
        "rewarded",
        "staff_rejected",
        "disputed",
        "scored",
        "pending_staff_validation",
    }
    bad = set(parts) - valid
    if bad:
        raise argparse.ArgumentTypeError(
            f"unknown status(es): {sorted(bad)}. valid: {sorted(valid)}"
        )
    return parts


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="export_to_label_studio",
        description="Export staff-approved meal sessions to Label Studio import JSON.",
    )
    ap.add_argument(
        "--since",
        type=_parse_date,
        default=None,
        help="Only export sessions started on/after this date (UTC). YYYY-MM-DD or ISO 8601.",
    )
    ap.add_argument(
        "--status",
        dest="statuses",
        type=_parse_statuses,
        default=DEFAULT_STATUSES,
        help=(
            "Comma-separated list of meal_sessions.status values to include. "
            f"Default: {','.join(DEFAULT_STATUSES)}."
        ),
    )
    ap.add_argument(
        "--restaurant-slug",
        default=None,
        help="Only export sessions from a single restaurant (matched on slug).",
    )
    ap.add_argument(
        "--max",
        dest="limit",
        type=int,
        default=500,
        help="Cap on tasks per run (default 500). Re-run to pick up the next batch.",
    )
    ap.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Path to write the Label Studio task JSON file.",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be exported without writing the file or DB rows.",
    )
    args = ap.parse_args(argv)

    settings = get_settings()
    engine = create_engine(settings.DATABASE_URL_SYNC, future=True)
    with Session(engine) as db:
        tasks = export(
            db,
            since=args.since,
            statuses=args.statuses,
            restaurant_slug=args.restaurant_slug,
            limit=args.limit,
            output=args.output,
            dry_run=args.dry_run,
        )

    where = args.output if not args.dry_run else "(dry-run, nothing written)"
    print(f"Exported {len(tasks)} task(s) → {where}")  # noqa: T201
    return 0


if __name__ == "__main__":
    sys.exit(main())
