"""Integration tests for the Label Studio export + import scripts.

Covers the export and import as units and as a round-trip:

- export() picks the right sessions and writes labeled_sessions rows
- export() is idempotent (re-runs don't re-pick the same sessions)
- export() skips sessions whose captures have been purged (rule 6)
- import_export() parses an LS-shaped JSON, writes the YOLO dataset on
  disk, downloads images via the storage module, and stamps the
  labeled_sessions row
- the train/val split is deterministic by session id

S3 is monkey-patched in two layers:
- storage.signed_url returns a synthetic URL (no MinIO needed)
- storage.download returns a synthetic PNG (so the import script can
  decode it and write JPEGs)
"""
from __future__ import annotations

import io
import json
import uuid as _uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID

import pytest
from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.consumption_score import ConsumptionScore
from app.models.labeled_session import LabeledSession
from app.models.meal_session import MealSession, MealSessionItem
from app.models.plate_capture import PlateCapture
from app.models.staff_validation import StaffValidation
from app.scripts import export_to_label_studio as exporter
from app.scripts import import_labels_from_ls as importer
from app.services import storage as storage_module
from tests.conftest import (
    make_restaurant,
    make_staff,
    make_table_code,
    register_diner,
)


def _png_bytes(color: tuple[int, int, int] = (200, 100, 50)) -> bytes:
    img = Image.new("RGB", (320, 240), color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _seed_approved_session(
    db: Session,
    *,
    restaurant_id,
    diner_id,
    menu_item_id,
    staff_id,
    decision: str = "approved",
    final_score: Decimal = Decimal("0.85"),
    before_key: str | None = "captures/seed-before.png",
    after_key: str | None = "captures/seed-after.png",
) -> MealSession:
    """One full chain of rows that makes a session export-eligible."""
    now = datetime.now(UTC)
    session = MealSession(
        diner_user_id=diner_id,
        restaurant_id=restaurant_id,
        table_code=make_table_code("ls"),
        status="rewarded" if decision != "rejected" else "staff_rejected",
        started_at=now - timedelta(hours=2),
        expires_at=now + timedelta(hours=2),
    )
    db.add(session)
    db.flush()
    db.add(
        MealSessionItem(
            meal_session_id=session.id,
            menu_item_id=menu_item_id,
            quantity=1,
        )
    )
    db.add(
        PlateCapture(
            meal_session_id=session.id,
            phase="before",
            image_s3_key=before_key,
            image_sha256="aa" * 32,
            captured_at=now - timedelta(hours=1, minutes=30),
            nonce="n-before",
        )
    )
    db.add(
        PlateCapture(
            meal_session_id=session.id,
            phase="after",
            image_s3_key=after_key,
            image_sha256="bb" * 32,
            captured_at=now - timedelta(hours=1),
            nonce="n-after",
        )
    )
    db.add(
        ConsumptionScore(
            meal_session_id=session.id,
            overall_score=final_score,
            per_item_scores=[],
            model_name="stub",
            model_version="v0",
            processing_ms=200,
            raw_model_output={},
        )
    )
    db.add(
        StaffValidation(
            meal_session_id=session.id,
            staff_user_id=staff_id,
            restaurant_id=restaurant_id,
            decision=decision,
            model_score=final_score,
            final_score=final_score,
            decided_at=now,
            decision_latency_ms=15_000,
        )
    )
    db.commit()
    db.refresh(session)
    return session


# ─── Export ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_export_writes_task_and_labeled_session(client, db, tmp_path, monkeypatch):
    monkeypatch.setattr(
        storage_module, "signed_url", lambda key, exp=900: f"https://fake/{key}?e={exp}"
    )
    restaurant, items, _ = make_restaurant(db, name="LS Export")
    main, _ = items
    diner_payload, _ = await register_diner(client, label="ls_export")
    diner_id = UUID(diner_payload["id"])
    staff = make_staff(db, restaurant.id)
    _seed_approved_session(
        db,
        restaurant_id=restaurant.id,
        diner_id=diner_id,
        menu_item_id=main.id,
        staff_id=staff.id,
    )

    output = tmp_path / "ls-tasks.json"
    tasks = exporter.export(
        db,
        since=None,
        statuses=exporter.DEFAULT_STATUSES,
        restaurant_slug=restaurant.slug,
        limit=100,
        output=output,
    )

    assert len(tasks) == 1
    task = tasks[0]
    assert task["data"]["restaurant"] == "LS Export"
    assert task["data"]["restaurant_slug"] == restaurant.slug
    assert task["data"]["staff_final_score"] == pytest.approx(0.85, abs=0.001)
    assert task["data"]["image_before"].startswith("https://fake/")
    assert task["data"]["image_after"].startswith("https://fake/")
    assert "Test Main" in task["data"]["dishes_summary"]

    written = json.loads(output.read_text())
    assert written == tasks

    rows = db.execute(
        select(LabeledSession).where(
            LabeledSession.meal_session_id == UUID(task["data"]["session_id"])
        )
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].labels_imported_at is None
    assert rows[0].label_count == 0


@pytest.mark.asyncio
async def test_export_is_idempotent(client, db, tmp_path, monkeypatch):
    """Second call after a complete export picks zero new sessions."""
    monkeypatch.setattr(
        storage_module, "signed_url", lambda key, exp=900: f"https://fake/{key}"
    )
    restaurant, items, _ = make_restaurant(db, name="LS Idem")
    main, _ = items
    diner_payload, _ = await register_diner(client, label="ls_idem")
    diner_id = UUID(diner_payload["id"])
    staff = make_staff(db, restaurant.id)
    _seed_approved_session(
        db,
        restaurant_id=restaurant.id,
        diner_id=diner_id,
        menu_item_id=main.id,
        staff_id=staff.id,
    )

    first_path = tmp_path / "ls-1.json"
    first = exporter.export(
        db,
        since=None,
        statuses=exporter.DEFAULT_STATUSES,
        restaurant_slug=restaurant.slug,
        limit=100,
        output=first_path,
    )
    assert len(first) == 1

    second_path = tmp_path / "ls-2.json"
    second = exporter.export(
        db,
        since=None,
        statuses=exporter.DEFAULT_STATUSES,
        restaurant_slug=restaurant.slug,
        limit=100,
        output=second_path,
    )
    assert second == []
    # An empty array is still written so the file is consistent.
    assert json.loads(second_path.read_text()) == []


@pytest.mark.asyncio
async def test_export_skips_purged_captures(client, db, tmp_path, monkeypatch):
    """The retention job clears image_s3_key. Those rows are non-exportable."""
    monkeypatch.setattr(
        storage_module, "signed_url", lambda key, exp=900: f"https://fake/{key}"
    )
    restaurant, items, _ = make_restaurant(db, name="LS Purged")
    main, _ = items
    diner_payload, _ = await register_diner(client, label="ls_purged")
    diner_id = UUID(diner_payload["id"])
    staff = make_staff(db, restaurant.id)
    _seed_approved_session(
        db,
        restaurant_id=restaurant.id,
        diner_id=diner_id,
        menu_item_id=main.id,
        staff_id=staff.id,
        before_key=None,  # purged
        after_key=None,
    )

    output = tmp_path / "ls.json"
    tasks = exporter.export(
        db,
        since=None,
        statuses=exporter.DEFAULT_STATUSES,
        restaurant_slug=restaurant.slug,
        limit=100,
        output=output,
    )
    assert tasks == []


@pytest.mark.asyncio
async def test_export_dry_run_does_not_write(client, db, tmp_path, monkeypatch):
    monkeypatch.setattr(
        storage_module, "signed_url", lambda key, exp=900: f"https://fake/{key}"
    )
    restaurant, items, _ = make_restaurant(db, name="LS Dry")
    main, _ = items
    diner_payload, _ = await register_diner(client, label="ls_dry")
    diner_id = UUID(diner_payload["id"])
    staff = make_staff(db, restaurant.id)
    session = _seed_approved_session(
        db,
        restaurant_id=restaurant.id,
        diner_id=diner_id,
        menu_item_id=main.id,
        staff_id=staff.id,
    )

    output = tmp_path / "ls.json"
    tasks = exporter.export(
        db,
        since=None,
        statuses=exporter.DEFAULT_STATUSES,
        restaurant_slug=restaurant.slug,
        limit=100,
        output=output,
        dry_run=True,
    )
    assert len(tasks) == 1
    assert not output.exists()
    # No labeled_session row was created either.
    assert (
        db.execute(
            select(LabeledSession).where(LabeledSession.meal_session_id == session.id)
        ).scalar_one_or_none()
        is None
    )


# ─── Pure helpers ───────────────────────────────────────────────────────


def test_split_is_deterministic_by_session_id():
    """The same UUID always lands in the same split — important so the
    val set doesn't drift between training runs."""
    sid = UUID("12345678-1234-5678-1234-567812345678")
    assert importer._is_val_split(sid) == importer._is_val_split(sid)


def test_split_distribution_is_roughly_80_20():
    """Out of 1000 random uuids, ~20% should land in val. Loose bounds
    so flakiness doesn't bite — we just want to know the function isn't
    degenerate (e.g. always train)."""
    val = sum(1 for _ in range(1000) if importer._is_val_split(_uuid.uuid4()))
    assert 100 < val < 300


def test_normalised_yolo_line_clamps_to_unit_interval():
    line = importer._normalised_yolo_line(
        3,
        [(50.0, 50.0), (200.0, -10.0), (75.5, 25.25)],
    )
    parts = line.split()
    assert parts[0] == "3"
    coords = [float(x) for x in parts[1:]]
    assert coords == [0.5, 0.5, 1.0, 0.0, 0.755, 0.2525]


def test_polygons_for_image_filters_by_to_name():
    """LS annotations have separate polygon groups for before vs after.
    We must read only the polygons whose to_name matches the image field
    we're processing."""
    annotation = {
        "result": [
            {
                "type": "polygonlabels",
                "to_name": "image_before",
                "value": {
                    "polygonlabels": ["rice"],
                    "points": [[10, 10], [20, 10], [20, 20]],
                },
            },
            {
                "type": "polygonlabels",
                "to_name": "image_after",
                "value": {
                    "polygonlabels": ["curry"],
                    "points": [[30, 30], [40, 30], [40, 40]],
                },
            },
            {
                "type": "choices",
                "to_name": "image_before",
                "value": {"choices": ["blurry"]},
            },
        ]
    }
    before = importer._polygons_for_image(annotation, "image_before")
    after = importer._polygons_for_image(annotation, "image_after")
    assert len(before) == 1 and before[0][0] == "rice"
    assert len(after) == 1 and after[0][0] == "curry"


# ─── Import ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_import_writes_yolo_dataset(client, db, tmp_path, monkeypatch):
    """End-to-end: feed a hand-crafted LS export, verify YOLO files on
    disk, verify labeled_sessions stamped, verify data.yaml has the
    class list."""
    restaurant, items, _ = make_restaurant(db, name="LS Import")
    main, _ = items
    diner_payload, _ = await register_diner(client, label="ls_import")
    diner_id = UUID(diner_payload["id"])
    staff = make_staff(db, restaurant.id)
    session = _seed_approved_session(
        db,
        restaurant_id=restaurant.id,
        diner_id=diner_id,
        menu_item_id=main.id,
        staff_id=staff.id,
        before_key="captures/imp-before.png",
        after_key="captures/imp-after.png",
    )

    # storage.download returns synthetic image bytes for any key.
    monkeypatch.setattr(
        storage_module, "download", lambda key: _png_bytes()
    )

    # Construct an LS export with one polygon per image.
    ls_export = [
        {
            "data": {"session_id": str(session.id)},
            "annotations": [
                {
                    "result": [
                        {
                            "type": "polygonlabels",
                            "to_name": "image_before",
                            "value": {
                                "polygonlabels": ["rice"],
                                "points": [[10, 10], [20, 10], [20, 20], [10, 20]],
                            },
                        },
                        {
                            "type": "polygonlabels",
                            "to_name": "image_after",
                            "value": {
                                "polygonlabels": ["curry"],
                                "points": [[30, 30], [40, 30], [40, 40], [30, 40]],
                            },
                        },
                    ]
                }
            ],
        }
    ]
    in_path = tmp_path / "ls-export.json"
    in_path.write_text(json.dumps(ls_export))
    out_dir = tmp_path / "datasets" / "v1"

    stats = importer.import_export(db, input_path=in_path, output_dir=out_dir)

    assert stats.tasks_seen == 1
    assert stats.tasks_imported == 1
    assert stats.images_written == 2
    assert stats.label_lines_written == 2

    # data.yaml
    yaml_text = (out_dir / "data.yaml").read_text()
    assert "rice" in yaml_text and "curry" in yaml_text
    assert f"nc: {len(importer.CLASS_NAMES)}" in yaml_text

    # The session may have landed in train OR val — pick whichever split exists.
    splits = [s for s in ("train", "val") if any((out_dir / "images" / s).iterdir())]
    assert len(splits) == 1, (
        f"Expected exactly one split populated, got {splits}"
    )
    split = splits[0]

    before_img = out_dir / "images" / split / f"{session.id}-before.jpg"
    after_img = out_dir / "images" / split / f"{session.id}-after.jpg"
    before_lbl = out_dir / "labels" / split / f"{session.id}-before.txt"
    after_lbl = out_dir / "labels" / split / f"{session.id}-after.txt"
    assert before_img.exists()
    assert after_img.exists()
    assert before_lbl.exists()
    assert after_lbl.exists()

    # Class indices come from CLASS_INDEX — rice and curry must match.
    assert before_lbl.read_text().split()[0] == str(importer.CLASS_INDEX["rice"])
    assert after_lbl.read_text().split()[0] == str(importer.CLASS_INDEX["curry"])

    # labeled_sessions row stamped.
    ls_row = db.execute(
        select(LabeledSession).where(LabeledSession.meal_session_id == session.id)
    ).scalar_one()
    assert ls_row.labels_imported_at is not None
    assert ls_row.label_count == 2


@pytest.mark.asyncio
async def test_import_handles_unknown_label_values(client, db, tmp_path, monkeypatch):
    """A labeller introduced a class name we don't have in CLASS_NAMES.
    We log it as a warning and skip that polygon — we don't crash."""
    restaurant, items, _ = make_restaurant(db, name="LS Unknown")
    main, _ = items
    diner_payload, _ = await register_diner(client, label="ls_unknown")
    diner_id = UUID(diner_payload["id"])
    staff = make_staff(db, restaurant.id)
    session = _seed_approved_session(
        db,
        restaurant_id=restaurant.id,
        diner_id=diner_id,
        menu_item_id=main.id,
        staff_id=staff.id,
    )
    monkeypatch.setattr(storage_module, "download", lambda key: _png_bytes())

    ls_export = [
        {
            "data": {"session_id": str(session.id)},
            "annotations": [
                {
                    "result": [
                        {
                            "type": "polygonlabels",
                            "to_name": "image_before",
                            "value": {
                                "polygonlabels": ["pickled_olive"],  # not in CLASS_NAMES
                                "points": [[5, 5], [15, 5], [15, 15]],
                            },
                        },
                        {
                            "type": "polygonlabels",
                            "to_name": "image_after",
                            "value": {
                                "polygonlabels": ["rice"],
                                "points": [[5, 5], [15, 5], [15, 15]],
                            },
                        },
                    ]
                }
            ],
        }
    ]
    in_path = tmp_path / "ls-export.json"
    in_path.write_text(json.dumps(ls_export))
    out_dir = tmp_path / "datasets" / "warn"

    stats = importer.import_export(db, input_path=in_path, output_dir=out_dir)
    assert "pickled_olive" in stats.unknown_label_warnings
    assert stats.label_lines_written == 1  # only the rice line landed


@pytest.mark.asyncio
async def test_round_trip_export_then_import(client, db, tmp_path, monkeypatch):
    """End-to-end: run export, fake what LS would emit, run import.
    The labeled_session row should carry both exported_at and
    labels_imported_at."""
    monkeypatch.setattr(
        storage_module, "signed_url", lambda key, exp=900: f"https://fake/{key}"
    )
    monkeypatch.setattr(storage_module, "download", lambda key: _png_bytes())

    restaurant, items, _ = make_restaurant(db, name="LS Round")
    main, _ = items
    diner_payload, _ = await register_diner(client, label="ls_round")
    diner_id = UUID(diner_payload["id"])
    staff = make_staff(db, restaurant.id)
    session = _seed_approved_session(
        db,
        restaurant_id=restaurant.id,
        diner_id=diner_id,
        menu_item_id=main.id,
        staff_id=staff.id,
    )

    export_path = tmp_path / "exported.json"
    tasks = exporter.export(
        db,
        since=None,
        statuses=exporter.DEFAULT_STATUSES,
        restaurant_slug=restaurant.slug,
        limit=100,
        output=export_path,
    )
    assert len(tasks) == 1

    # Wrap each exported task with the bare-minimum annotation a labeller
    # would have produced.
    ls_export = []
    for task in tasks:
        ls_export.append(
            {
                "data": task["data"],
                "annotations": [
                    {
                        "result": [
                            {
                                "type": "polygonlabels",
                                "to_name": "image_before",
                                "value": {
                                    "polygonlabels": ["dal"],
                                    "points": [
                                        [10, 10], [50, 10], [50, 40], [10, 40]
                                    ],
                                },
                            }
                        ]
                    }
                ],
            }
        )
    import_in = tmp_path / "ls-export.json"
    import_in.write_text(json.dumps(ls_export))
    out_dir = tmp_path / "datasets" / "round"

    stats = importer.import_export(db, input_path=import_in, output_dir=out_dir)
    assert stats.tasks_imported == 1
    assert stats.label_lines_written == 1

    row = db.execute(
        select(LabeledSession).where(LabeledSession.meal_session_id == session.id)
    ).scalar_one()
    assert row.exported_at is not None
    assert row.labels_imported_at is not None
    assert row.label_count == 1
