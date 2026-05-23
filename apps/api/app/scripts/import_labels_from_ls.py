"""Import labels from a Label Studio JSON export → YOLO-seg dataset on disk.

Second half of the data labelling pipeline (CLAUDE.md §9 Phase 2). The
first half is `export_to_label_studio.py`. See
`services/vision/labeling/README.md` for the full workflow.

What this script does
- Reads a Label Studio JSON export (one task per object in the array;
  each task carries 0..N `annotations`, each with 0..N polygon
  `result`s that have a `value.points` list and a `value.polygonlabels`
  list).
- For each task that has at least one polygon result:
  1. Downloads the before + after images from MinIO/S3 using the
     `image_s3_key` recovered from the `session_id` we exported in
     `data.session_id`. We never rely on the signed URLs in the export
     — those have expired by now.
  2. Writes the images to `<output-dir>/images/{train,val}/...jpg`.
  3. Converts each polygon (points are in LS's percent-of-image-side
     coords) to YOLO-seg label lines in
     `<output-dir>/labels/{train,val}/<image_stem>.txt`.
  4. Splits 80/20 between train and val **deterministically by
     session_id** so re-runs are stable.
  5. Marks the matching labeled_sessions row's `labels_imported_at`
     + `label_count`.
- Finally, writes `<output-dir>/data.yaml` with the class names and
  dataset paths so `ultralytics yolo train data=…/data.yaml` works.

What this script intentionally doesn't do
- Touch the Label Studio API. LS exports a JSON file; we read the
  file. No webhook, no API keys, no live polling.
- Train a model. That's a separate side-task that needs a GPU.

Run
    python -m app.scripts.import_labels_from_ls \\
        --input /tmp/ls-export.json \\
        --output-dir datasets/v1
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.labeled_session import LabeledSession
from app.models.meal_session import MealSession
from app.models.plate_capture import PlateCapture
from app.services import storage

# Class list mirrors the <Label value="…"/> entries in
# services/vision/labeling/config.xml. Order is meaningful — the index
# in this list becomes the YOLO class id. Edit both files together.
CLASS_NAMES: list[str] = [
    "rice",
    "dal",
    "curry",
    "bread",
    "vegetable",
    "meat",
    "seafood",
    "dessert",
    "drink",
    "other_food",
]
CLASS_INDEX: dict[str, int] = {name: i for i, name in enumerate(CLASS_NAMES)}

# 80/20 deterministic split by session id.
VAL_FRACTION = 0.2


class ImportStats:
    """Running tallies for the final summary print."""

    __slots__ = (
        "tasks_seen",
        "tasks_imported",
        "tasks_skipped_no_polygons",
        "tasks_skipped_no_session",
        "images_written",
        "label_lines_written",
        "unknown_label_warnings",
    )

    def __init__(self) -> None:
        self.tasks_seen = 0
        self.tasks_imported = 0
        self.tasks_skipped_no_polygons = 0
        self.tasks_skipped_no_session = 0
        self.images_written = 0
        self.label_lines_written = 0
        self.unknown_label_warnings: set[str] = set()


def _is_val_split(session_id: UUID, val_fraction: float = VAL_FRACTION) -> bool:
    """Deterministic 80/20 train/val by hashing session_id. Same session
    always lands in the same split across re-runs — important so the val
    set doesn't drift between training runs."""
    digest = hashlib.sha256(session_id.bytes).digest()
    # Use 2 bytes for plenty of resolution.
    bucket = int.from_bytes(digest[:2], "big") / 65535.0
    return bucket < val_fraction


def _polygons_for_image(annotation: dict[str, Any], image_field: str) -> list[
    tuple[str, list[tuple[float, float]]]
]:
    """Pull every polygon from one LS annotation that's pinned to the
    given image field (e.g. 'image_before'). Returns a list of
    (label_value, [(x_pct, y_pct), ...]) tuples.

    LS's `result` entries look roughly like:
        {
          "type": "polygonlabels",
          "from_name": "labels_before",
          "to_name": "image_before",
          "value": {
            "points": [[12.5, 34.1], ...],
            "polygonlabels": ["rice"]
          }
        }
    """
    polygons: list[tuple[str, list[tuple[float, float]]]] = []
    for result in annotation.get("result", []):
        if result.get("type") != "polygonlabels":
            continue
        if result.get("to_name") != image_field:
            continue
        value = result.get("value", {})
        labels = value.get("polygonlabels") or value.get("labels") or []
        points = value.get("points") or []
        if not labels or not points:
            continue
        polygons.append((labels[0], [(float(x), float(y)) for x, y in points]))
    return polygons


def _normalised_yolo_line(
    cls_idx: int, points_pct: list[tuple[float, float]]
) -> str:
    """YOLO-seg label line: class_idx x1 y1 x2 y2 ... in [0, 1].

    LS stores points as percentages [0, 100] of the image side. Divide
    by 100 and clamp into [0, 1] to be safe against floating-point noise
    on the boundary.
    """
    parts = [str(cls_idx)]
    for x, y in points_pct:
        nx = max(0.0, min(1.0, x / 100.0))
        ny = max(0.0, min(1.0, y / 100.0))
        parts.append(f"{nx:.6f}")
        parts.append(f"{ny:.6f}")
    return " ".join(parts)


def _resolve_capture_keys(
    db: Session, session_id: UUID
) -> tuple[str | None, str | None]:
    """Look up live S3 keys for this session's before + after captures.
    Returns (before_key, after_key); either can be None if the row's
    image_s3_key was purged by the retention job between export and
    import — in which case we skip this task."""
    rows = db.execute(
        select(PlateCapture.phase, PlateCapture.image_s3_key).where(
            PlateCapture.meal_session_id == session_id,
            PlateCapture.image_s3_key.is_not(None),
        )
    ).all()
    by_phase = {phase: key for phase, key in rows}
    return by_phase.get("before"), by_phase.get("after")


def _save_image(bytes_: bytes, dest: Path) -> None:
    """Decode + save as JPEG so the dataset has a uniform format
    regardless of whether the capture was PNG or JPG originally. JPEG
    quality 92 keeps it readable for downstream training without
    bloating disk usage."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    img = Image.open(io.BytesIO(bytes_))
    if img.mode != "RGB":
        img = img.convert("RGB")
    img.save(dest, format="JPEG", quality=92)


def _process_task(
    task: dict[str, Any],
    *,
    db: Session,
    output_dir: Path,
    stats: ImportStats,
) -> None:
    """One LS task → up to 2 images + 2 label files written to disk."""
    stats.tasks_seen += 1
    data = task.get("data") or {}
    session_id_str = data.get("session_id")
    if not session_id_str:
        stats.tasks_skipped_no_session += 1
        return
    try:
        session_id = UUID(session_id_str)
    except ValueError:
        stats.tasks_skipped_no_session += 1
        return

    annotations = task.get("annotations") or []
    if not annotations:
        stats.tasks_skipped_no_polygons += 1
        return

    # Combine polygons across all annotations for this task — multiple
    # labellers' answers all count as ground truth (Label Studio handles
    # consensus separately if you've configured it).
    before_polys: list[tuple[str, list[tuple[float, float]]]] = []
    after_polys: list[tuple[str, list[tuple[float, float]]]] = []
    for annotation in annotations:
        before_polys.extend(_polygons_for_image(annotation, "image_before"))
        after_polys.extend(_polygons_for_image(annotation, "image_after"))

    if not before_polys and not after_polys:
        stats.tasks_skipped_no_polygons += 1
        return

    before_key, after_key = _resolve_capture_keys(db, session_id)
    split = "val" if _is_val_split(session_id) else "train"

    for phase, key, polys in (
        ("before", before_key, before_polys),
        ("after", after_key, after_polys),
    ):
        if key is None or not polys:
            continue
        try:
            image_bytes = storage.download(key)
        except Exception as exc:  # noqa: BLE001 — pass to caller via stderr below
            print(  # noqa: T201
                f"WARN: skipping {session_id}/{phase}: download failed ({exc})",
                file=sys.stderr,
            )
            continue

        img_path = output_dir / "images" / split / f"{session_id}-{phase}.jpg"
        lbl_path = output_dir / "labels" / split / f"{session_id}-{phase}.txt"
        _save_image(image_bytes, img_path)
        stats.images_written += 1

        lbl_path.parent.mkdir(parents=True, exist_ok=True)
        lines: list[str] = []
        for label_value, points_pct in polys:
            if label_value not in CLASS_INDEX:
                stats.unknown_label_warnings.add(label_value)
                continue
            lines.append(_normalised_yolo_line(CLASS_INDEX[label_value], points_pct))
        lbl_path.write_text("\n".join(lines) + ("\n" if lines else ""))
        stats.label_lines_written += len(lines)

    # Mark the labeled_session row.
    row = db.execute(
        select(LabeledSession).where(LabeledSession.meal_session_id == session_id)
    ).scalar_one_or_none()
    if row is None:
        # The session was exported via a different path (e.g. directly to LS
        # via API). Create a stub row so the bookkeeping reflects reality.
        row = LabeledSession(
            meal_session_id=session_id,
            exported_at=datetime.now(UTC),
        )
        db.add(row)
        db.flush()
    row.labels_imported_at = datetime.now(UTC)
    row.label_count = (row.label_count or 0) + len(before_polys) + len(after_polys)
    stats.tasks_imported += 1


def _write_data_yaml(output_dir: Path) -> None:
    """YOLO/Ultralytics dataset descriptor. Absolute paths so the file
    works no matter where `yolo train` is invoked from."""
    abs_dir = output_dir.resolve()
    lines = [
        f"path: {abs_dir}",
        "train: images/train",
        "val: images/val",
        "",
        f"nc: {len(CLASS_NAMES)}",
        "names:",
    ]
    for i, name in enumerate(CLASS_NAMES):
        lines.append(f"  {i}: {name}")
    (output_dir / "data.yaml").write_text("\n".join(lines) + "\n")


def import_export(
    db: Session,
    *,
    input_path: Path,
    output_dir: Path,
) -> ImportStats:
    """Read the LS export, write the YOLO dataset, return summary stats."""
    raw = json.loads(input_path.read_text())
    if not isinstance(raw, list):
        raise ValueError(
            "Expected a JSON array of Label Studio tasks at the top level."
        )
    output_dir.mkdir(parents=True, exist_ok=True)
    for sub in ("images/train", "images/val", "labels/train", "labels/val"):
        (output_dir / sub).mkdir(parents=True, exist_ok=True)

    stats = ImportStats()
    for task in raw:
        _process_task(task, db=db, output_dir=output_dir, stats=stats)

    db.commit()
    _write_data_yaml(output_dir)
    return stats


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="import_labels_from_ls",
        description="Import a Label Studio JSON export into a YOLO-seg dataset.",
    )
    ap.add_argument(
        "--input",
        type=Path,
        required=True,
        help="Path to the Label Studio JSON export file.",
    )
    ap.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory for the YOLO dataset. Created if missing.",
    )
    args = ap.parse_args(argv)

    if not args.input.exists():
        print(f"ERROR: --input not found: {args.input}", file=sys.stderr)  # noqa: T201
        return 2

    settings = get_settings()
    engine = create_engine(settings.DATABASE_URL_SYNC, future=True)
    with Session(engine) as db:
        # Sanity-check we even have a Postgres connection — fail loud if not.
        db.execute(select(MealSession).limit(0))
        stats = import_export(db, input_path=args.input, output_dir=args.output_dir)

    print(  # noqa: T201
        f"Imported {stats.tasks_imported}/{stats.tasks_seen} task(s) → {args.output_dir}\n"
        f"  images written: {stats.images_written}\n"
        f"  label lines:    {stats.label_lines_written}\n"
        f"  skipped (no polygons):  {stats.tasks_skipped_no_polygons}\n"
        f"  skipped (no session):   {stats.tasks_skipped_no_session}"
    )
    if stats.unknown_label_warnings:
        print(  # noqa: T201
            "  WARN: unknown label values (skipped): "
            + ", ".join(sorted(stats.unknown_label_warnings)),
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
