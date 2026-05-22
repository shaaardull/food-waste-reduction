# services/vision

Standalone vision-inference microservice for Plate-Clean Rewards. Receives
a `POST /infer` with a `before_image_url`, `after_image_url`, and the list
of ordered dishes; returns a normalized consumption-score blob that
matches CLAUDE.md §6.1.

Three pluggable backends, selected by `VISION_BACKEND`:

| `VISION_BACKEND=` | What it does | Cost | Latency |
|---|---|---|---|
| `stub` (default) | Returns 0.8 for every dish. Dev + tests. | free | <1 ms |
| `anthropic` | Calls Claude with both images + the §6.1 tool definition. Phase 1 baseline. | API tokens | ~3-8 s |
| `yolo` | Local YOLOv8/v11-seg + LAB-space food-pixel coverage. Phase 2 baseline. | free after model download | ~200 ms on CPU |

The contract (`InferOut` in `app/schemas.py`) is identical across all
three so the rest of the system never knows which backend ran.

## Running the service

```bash
# From repo root, services/vision boots automatically via scripts/dev.sh.
# Or run it directly:
cd services/vision
./.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

Health probe:

```bash
curl -s localhost:8001/health
# {"status":"ok","version":"0.1.0","backend":"stub"}
```

## Enabling the YOLO backend

The `yolo` backend uses an off-the-shelf pretrained YOLOv8n-seg model from
Ultralytics (COCO classes — bowl, cup, dining table, pizza, etc.) to
segment food/container regions in both photos, then measures
food-coloured pixel coverage inside those masks via LAB-space chroma
thresholding:

```
consumption = max(0, 1 - (after_food_pixels / before_food_pixels))
```

It's a real vision-derived score with no LLM round-trip. The fine-tuned
YOLOv11-seg on collected restaurant data (CLAUDE.md §9 Phase 2) drops in
here later by changing `YOLO_MODEL_PATH`; nothing else changes.

### Install

The deps are heavy (torch + ultralytics + numpy ≈ 500 MB) so they're an
optional install:

```bash
cd services/vision
./.venv/bin/pip install --ignore-requires-python -e ".[yolo]"
```

If you'd rather not install torch locally, the `anthropic` backend remains
a fine choice — set `ANTHROPIC_API_KEY` and `VISION_BACKEND=anthropic`.

### Enable

Add to your shell or `.env`:

```bash
export VISION_BACKEND=yolo
# optional — defaults to the COCO-pretrained nano model
# export YOLO_MODEL_PATH=yolov8n-seg.pt
```

Then restart the service. The first `/infer` call downloads the ~7 MB
weights from the Ultralytics CDN to `~/.cache/torch/hub/checkpoints/`
(or wherever ultralytics caches by default) and runs the inference.
Subsequent calls reuse the cached weights.

### What the model actually sees

Because COCO has no Indian-meal classes, the YOLO backend's job is two
things:

1. **Find the plates / bowls / cups / dining table** in each photo
   (these are real COCO classes — `bowl`, `cup`, `dining table`, plus a
   handful of generic foods like `pizza`, `banana`, `sandwich`).
2. **Measure food-coloured pixels** inside those regions. A pixel
   qualifies when its LAB chroma `sqrt(a*² + b*²) > 20` and lightness
   sits between 10 and 240 — plates/napkins are near-neutral so they
   drop out; shadows are too dark; specular highlights are too bright.

If YOLO finds no relevant objects, the backend falls back to whole-image
coverage so it still produces a number — and flags `suspicious=true` so
staff get an extra-careful banner.

Per-dish breakdown is **not** computed today — every ordered dish
receives the overall figure. Once a class-aware fine-tuned model lands
(Phase 2 ML task), the per-item numbers light up automatically because
the interface already supports them.

### Notes string the staff dashboard sees

```
YOLO detected 2 food/container class(es) before (bowl, dining table);
1 after (bowl). Food-pixel coverage went from 18432 to 4120 (ratio 0.22).
```

### Suspicious gate

Two conditions flip `suspicious=true`, which sends the validation case to
staff with a red banner:

- No food/container detected in either frame (bad angle, wrong photo).
- `after_food_pixels > 1.3 × before_food_pixels` (the after-photo
  somehow has more food than the before — either wrong plate or
  tampering).

## Testing

```bash
./.venv/bin/pytest
```

The YOLO test file (`tests/test_yolo_backend.py`) auto-skips the one
end-to-end test if `ultralytics` isn't importable, so the base venv
still gets a green suite.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `VISION_BACKEND` | `stub` | `stub` / `anthropic` / `yolo` |
| `ANTHROPIC_API_KEY` | _empty_ | Required when `VISION_BACKEND=anthropic` |
| `VISION_MODEL` | `claude-sonnet-4-5` | Anthropic model id |
| `VISION_TIMEOUT_SECONDS` | `30` | Anthropic call timeout |
| `YOLO_MODEL_PATH` | _empty_ | When empty, defaults to `yolov8n-seg.pt` |
| `IMAGE_FETCH_TIMEOUT_SECONDS` | `10` | Per-image fetch timeout |
| `MAX_IMAGE_BYTES` | `5242880` | 5 MB per image |
