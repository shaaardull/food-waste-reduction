# Data labelling pipeline (Label Studio)

Phase 2 §9 from `CLAUDE.md`: collect labelled segmentation data from real
plate captures so we can fine-tune the YOLO backend on actual restaurant
food (rice / dal / curry / bread / etc.) instead of relying on COCO's
generic "bowl" + "cup" classes.

This directory holds:

- [`config.xml`](./config.xml) — the Label Studio labelling-interface
  definition. Paste it into LS once when you create the project.
- This README — the end-to-end workflow.

The actual export + import code lives in
`apps/api/app/scripts/export_to_label_studio.py` and
`apps/api/app/scripts/import_labels_from_ls.py`.

## Round-trip overview

```
[Postgres + MinIO]                                                 [Label Studio]
       │                                                                  ▲
       │   1. export                                                      │
       │      python -m app.scripts.export_to_label_studio                │
       │           --since 2026-05-01 --output ls-tasks.json              │
       │                                                                  │
       ├─► ls-tasks.json   ── Import tasks ──────────────────────────────►│
       │                                                                  │
       │                                                          2. label
       │                                                          humans draw polygons
       │                                                                  │
       │   ◄── Export labels (JSON) ─────────────────────────────────────┤
       │                                                                  │
       │   3. import                                                      │
       │      python -m app.scripts.import_labels_from_ls                 │
       │           --input ls-export.json --output-dir datasets/v1        │
       │                                                                  │
       ▼                                                                  │
datasets/v1/                                                              │
├── data.yaml          # YOLO dataset descriptor                          │
├── images/                                                               │
│   ├── train/                                                            │
│   └── val/                                                              │
└── labels/                                                               │
    ├── train/         # one .txt per image, YOLO-seg format              │
    └── val/                                                              │
```

The `datasets/` tree is the input format Ultralytics' training command
expects. Once you have enough labelled samples (a few hundred to start),
the next task is `python -m ultralytics train data=datasets/v1/data.yaml`
in a side project; the resulting `.pt` file gets dropped into the YOLO
backend via `YOLO_MODEL_PATH`.

## 1. Install Label Studio

Label Studio runs as its own service. The cheapest way locally:

```bash
pip install label-studio
label-studio start --port 8080 --no-browser
# open http://localhost:8080, create an account
```

Or via Docker if you prefer:

```bash
docker run -it -p 8080:8080 \
  -v "$HOME/.local-label-studio:/label-studio/data" \
  heartexlabs/label-studio:latest
```

LS data persists in `~/.local-label-studio` (or your mount). We treat LS
itself as an external tool — no integration with the running Plate-Clean
stack beyond the JSON files.

## 2. Create the labelling project

1. Sign in, **Create** project.
2. Skip "Data Import" — we'll feed it via JSON file later.
3. **Labeling Setup → Custom template → Code**: paste the contents of
   [`config.xml`](./config.xml). Save.
4. **Settings → General**: name the project something like
   `plate-clean-v1` so the export is easy to identify later.

## 3. Export tasks from the running app

The export script reads from Postgres (sessions) and MinIO (signed URLs)
so the running app stack has to be up. Use `scripts/dev.sh` if it isn't.

```bash
cd apps/api
DATABASE_URL_SYNC="postgresql://plate:plate@localhost:5432/plate_clean" \
S3_ENDPOINT="http://localhost:9000" \
S3_BUCKET="plate-clean-images" \
S3_ACCESS_KEY="minioadmin" S3_SECRET_KEY="minioadmin" \
  ./.venv/bin/python -m app.scripts.export_to_label_studio \
    --since 2026-05-01 \
    --output /tmp/ls-tasks.json
```

Flags:

| Flag | What it does |
|---|---|
| `--since YYYY-MM-DD` | Only export sessions started on/after this date (UTC). |
| `--status A,B,...` | Comma-separated statuses to include. Default: `staff_approved,rewarded`. |
| `--restaurant-slug spice-trail` | Limit to one restaurant. |
| `--max 500` | Cap per run; re-run to pick up the next batch. |
| `--dry-run` | Print the count without writing the JSON file or the `labeled_sessions` rows. |

The script is **idempotent** — sessions already in `labeled_sessions`
are skipped. So running it on a schedule is fine.

## 4. Upload the tasks to Label Studio

In the project: **Tasks → Import → Upload Files → ls-tasks.json**. Label
Studio shows one task per session; the labelling interface lays out the
before + after photos side-by-side with polygon tools for each.

For best results, instruct labellers to:

- Outline **every visible food region** in the before photo with the
  closest matching class. Don't worry about sauce smears or bones — only
  edible food.
- In the after photo, outline only **food that's still edible**. Skip
  non-edible residue (bones, shells, peels, finished plates with just
  smears).
- Use **Image quality flags** when a photo is blurry, dark, or the
  wrong subject. The training pipeline filters those out.
- Be generous with the polygon — a tighter mask is better than a loose
  one, but don't over-engineer it.

## 5. Export the labels from Label Studio

Once a batch is done: **Tasks → Export → JSON (Min)** (the minimal
shape is enough for our importer). Save the file as e.g.
`ls-export-2026-05-22.json`.

## 6. Import labels back into a YOLO dataset

```bash
cd apps/api
./.venv/bin/python -m app.scripts.import_labels_from_ls \
  --input /tmp/ls-export-2026-05-22.json \
  --output-dir datasets/v1
```

This:

1. Downloads each task's `image_before` and `image_after` from MinIO
   into `datasets/v1/images/{train,val}/<session_id>-{before,after}.jpg`.
2. Converts each polygon into the YOLO-seg label format
   (`<cls_idx> <x1> <y1> <x2> <y2> ...` in normalised coordinates) and
   writes one `.txt` file per image into `labels/{train,val}/`.
3. Splits 80/20 train/val **deterministically by session_id hash** so
   the same session always lands in the same split across runs.
4. Writes `data.yaml` with the class names and absolute paths.
5. Updates the matching `labeled_sessions` row with
   `labels_imported_at` + `label_count`.

The dataset on disk is ready to hand to `ultralytics`:

```bash
yolo train data=datasets/v1/data.yaml model=yolov8n-seg.pt epochs=50
```

(That step is **out of scope** for this repo right now — it needs a GPU
to be useful and is the next discrete piece of Phase 2 work.)

## Status check (any time)

```sql
SELECT
  COUNT(*) FILTER (WHERE labels_imported_at IS NULL) AS pending,
  COUNT(*) FILTER (WHERE labels_imported_at IS NOT NULL) AS imported,
  SUM(label_count) AS total_polygons
FROM labeled_sessions;
```

## Files in this directory

- `config.xml` — copy-paste this into Label Studio's interface editor.
- `README.md` — this file.

## What lives elsewhere

- `apps/api/app/scripts/export_to_label_studio.py` — export script.
- `apps/api/app/scripts/import_labels_from_ls.py` — import script.
- `apps/api/app/models/labeled_session.py` — ORM model.
- `apps/api/alembic/versions/0007_labeled_sessions.py` — migration.
- `datasets/` — output of the import script (gitignored).
