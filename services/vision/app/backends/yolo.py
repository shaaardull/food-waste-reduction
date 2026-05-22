"""YOLOv8/v11-seg backend.

Uses ultralytics' pretrained COCO segmentation weights to find food
containers + visible food in the before/after photos, then measures
food-coloured pixel coverage inside those masks via LAB-space chroma
thresholding.

    consumption = max(0, 1 - after_food_pixels / before_food_pixels)

This is the Phase 2 baseline backend (CLAUDE.md §9). It produces a real
vision-derived score with no LLM round-trip. The fine-tuned YOLOv11-seg
trained on collected restaurant data — the other half of the Phase 2
plan — drops in here later by changing `YOLO_MODEL_PATH`; the interface
is identical.

Install:
    pip install -e ".[yolo]"   # pulls torch + ultralytics + numpy

Enable:
    export VISION_BACKEND=yolo
    export YOLO_MODEL_PATH=yolov8n-seg.pt   # optional, this is the default

The model file auto-downloads from the Ultralytics CDN on first inference
(~7 MB for yolov8n-seg). The download is lazy — the service boots even
if the network's down; the failure surfaces only on the first /infer.
"""
from __future__ import annotations

import io
import time
from threading import Lock
from typing import Any

from app.backends.base import Backend, BackendUnavailable
from app.config import get_settings
from app.schemas import ExpectedDish, InferOut, PerItem

# COCO class IDs that we treat as "food / food container" for the purposes
# of building the union mask we measure food-pixel coverage inside.
# Order is fixed so the notes string is stable for snapshot tests.
COCO_FOOD_CONTAINER_CLASSES: dict[int, str] = {
    39: "bottle",
    40: "wine glass",
    41: "cup",
    45: "bowl",
    46: "banana",
    47: "apple",
    48: "sandwich",
    49: "orange",
    50: "broccoli",
    51: "carrot",
    52: "hot dog",
    53: "pizza",
    54: "donut",
    55: "cake",
    60: "dining table",
}

# LAB-space gates for "food-coloured" pixels.
# Pillow's LAB mode stores L in [0,255] (mapping to L* in [0,100]) and a,b
# as unsigned bytes biased by 128 (so true a*, b* run [-128, 127]).
# Plates / clean napkins sit near a*=b*=0; cooked food sits well off.
FOOD_CHROMA_THRESHOLD = 20  # min sqrt(a*² + b*²)
FOOD_LIGHTNESS_MIN = 10  # filter out pure-black shadows / deep wells
FOOD_LIGHTNESS_MAX = 240  # filter out blown-out highlights / specular


class _SegmentStats:
    """One-image segmentation result used to assemble the final score."""

    __slots__ = ("food_pixels", "total_pixels", "classes_seen", "detection_confidences")

    def __init__(
        self,
        *,
        food_pixels: int,
        total_pixels: int,
        classes_seen: set[str],
        detection_confidences: list[float],
    ) -> None:
        self.food_pixels = food_pixels
        self.total_pixels = total_pixels
        self.classes_seen = classes_seen
        self.detection_confidences = detection_confidences


class YoloBackend(Backend):
    name = "yolov8-seg"
    version = "0"

    def __init__(self) -> None:
        # Heavy deps are intentionally imported lazily so the service boots
        # in stub/anthropic mode without numpy / torch installed.
        try:
            import numpy  # noqa: F401
            from PIL import Image  # noqa: F401
            from ultralytics import YOLO  # noqa: F401
        except ImportError as exc:  # pragma: no cover - exercised in tests via monkeypatch
            raise BackendUnavailable(
                'YOLO deps not installed. Run `pip install -e ".[yolo]"` '
                "in services/vision and restart."
            ) from exc

        self._weights_ref = get_settings().YOLO_MODEL_PATH or "yolov8n-seg.pt"
        # Lazy-load the model on first inference so we don't pay the
        # ~7 MB download (or the cold weight read) on module import.
        self._model: Any = None
        self._lock = Lock()

    def _ensure_model(self) -> Any:
        if self._model is None:
            with self._lock:
                if self._model is None:
                    from ultralytics import YOLO

                    self._model = YOLO(self._weights_ref)
        return self._model

    def infer(
        self,
        before_image: bytes,
        before_mime: str,
        after_image: bytes,
        after_mime: str,
        expected_dishes: list[ExpectedDish],
    ) -> InferOut:
        start = time.perf_counter()
        model = self._ensure_model()

        before_stats = _segment_and_measure(model, before_image)
        after_stats = _segment_and_measure(model, after_image)

        consumption, ratio = _consumption_from_stats(before_stats, after_stats)
        confidence = _confidence_from_stats(before_stats, after_stats)
        suspicious = _is_suspicious(before_stats, after_stats, ratio)

        # No per-dish classifier today — every ordered dish gets the
        # overall figure. Staff can override on a per-item basis in the
        # validation UI; once we fine-tune a class-aware model, the
        # per-item numbers light up automatically.
        per_item = [
            PerItem(dish_name=d.name, consumption=consumption, confidence=confidence)
            for d in expected_dishes
        ]

        notes = _format_notes(before_stats, after_stats, ratio, suspicious)
        processing_ms = int((time.perf_counter() - start) * 1000)
        return InferOut(
            overall_consumption=consumption,
            per_item=per_item,
            confidence=confidence,
            notes=notes,
            suspicious=suspicious,
            backend=self.name,
            backend_version=self.version,
            processing_ms=processing_ms,
        )


# ─── Pure helpers (importable + unit-testable without ultralytics) ──────


def _consumption_from_stats(
    before: _SegmentStats, after: _SegmentStats
) -> tuple[float, float]:
    """Return (consumption, ratio). Ratio is after/before food-pixel
    fraction, used by the suspicious gate. Consumption is clamped [0, 1].
    """
    if before.food_pixels <= 0:
        return 0.0, 1.0
    ratio = after.food_pixels / before.food_pixels
    consumption = max(0.0, min(1.0, 1.0 - ratio))
    return consumption, ratio


def _confidence_from_stats(before: _SegmentStats, after: _SegmentStats) -> float:
    """Average YOLO detection confidence across both frames. Halved if
    one frame had no qualifying detections — that's an image-quality or
    coverage problem the staff member needs to know about.
    """
    confs = [*before.detection_confidences, *after.detection_confidences]
    if not confs:
        return 0.2
    avg = sum(confs) / len(confs)
    if not before.detection_confidences or not after.detection_confidences:
        avg *= 0.5
    return float(avg)


def _is_suspicious(
    before: _SegmentStats, after: _SegmentStats, ratio: float
) -> bool:
    """Flag for staff attention. Two cases:
    - No food/container detected in either frame → can't measure, send
      to staff with a banner.
    - More food after than before (ratio > 1.3) → either wrong plate
      photographed or a tampering attempt.
    """
    if before.food_pixels == 0 and after.food_pixels == 0:
        return True
    return ratio > 1.3


def _format_notes(
    before: _SegmentStats,
    after: _SegmentStats,
    ratio: float,
    suspicious: bool,
) -> str:
    before_cls = ", ".join(sorted(before.classes_seen)) or "none"
    after_cls = ", ".join(sorted(after.classes_seen)) or "none"
    parts = [
        f"YOLO detected {len(before.classes_seen)} food/container class(es) "
        f"before ({before_cls}); ",
        f"{len(after.classes_seen)} after ({after_cls}). ",
        f"Food-pixel coverage went from {before.food_pixels} to "
        f"{after.food_pixels} (ratio {ratio:.2f}).",
    ]
    if suspicious:
        reason = (
            "no food detected in either frame"
            if before.food_pixels == 0 and after.food_pixels == 0
            else "after-image shows more food than before"
        )
        parts.append(f" Suspicious: {reason} — please verify at the table.")
    return "".join(parts)


# ─── Numpy/PIL helpers (require the yolo extras) ────────────────────────


def _segment_and_measure(model: Any, image_bytes: bytes) -> _SegmentStats:
    """Run YOLO seg on one image and measure food-coloured pixel coverage
    inside the union mask of food/container detections.

    Falls back to whole-image coverage if YOLO finds nothing relevant —
    keeps the pipeline producing a number even on degenerate inputs.
    """
    import numpy as np
    from PIL import Image

    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    arr = np.array(img)  # (H, W, 3) uint8 RGB

    results = model.predict(source=arr, verbose=False)
    r = results[0]

    classes_seen: set[str] = set()
    detection_confidences: list[float] = []
    union_mask = np.zeros(arr.shape[:2], dtype=bool)

    masks_obj = getattr(r, "masks", None)
    boxes_obj = getattr(r, "boxes", None)
    if masks_obj is not None and boxes_obj is not None:
        masks_np = masks_obj.data.cpu().numpy()
        cls_ids = boxes_obj.cls.cpu().numpy().astype(int)
        confs = boxes_obj.conf.cpu().numpy()
        for mask, cls_id, conf in zip(masks_np, cls_ids, confs, strict=False):
            cid = int(cls_id)
            if cid not in COCO_FOOD_CONTAINER_CLASSES:
                continue
            classes_seen.add(COCO_FOOD_CONTAINER_CLASSES[cid])
            detection_confidences.append(float(conf))
            # Masks come out at model input resolution; resize back if needed.
            mh, mw = mask.shape
            if (mh, mw) != arr.shape[:2]:
                pil = Image.fromarray((mask > 0.5).astype(np.uint8) * 255)
                pil = pil.resize((arr.shape[1], arr.shape[0]), Image.NEAREST)
                bool_mask = np.asarray(pil) > 127
            else:
                bool_mask = mask > 0.5
            union_mask |= bool_mask

    if not union_mask.any():
        union_mask[:] = True

    food_mask = _food_pixel_mask(arr) & union_mask
    return _SegmentStats(
        food_pixels=int(food_mask.sum()),
        total_pixels=int(union_mask.sum()),
        classes_seen=classes_seen,
        detection_confidences=detection_confidences,
    )


def _food_pixel_mask(rgb: Any) -> Any:
    """Boolean mask of food-coloured pixels in an RGB image.

    Pixels qualify when their LAB chroma sqrt(a*² + b*²) exceeds
    FOOD_CHROMA_THRESHOLD AND lightness sits between FOOD_LIGHTNESS_MIN
    and FOOD_LIGHTNESS_MAX. Plates/napkins are near-neutral so they
    drop out. This is a classical heuristic — a fine-tuned food/non-food
    classifier is the next Phase 2 ML task.
    """
    import numpy as np
    from PIL import Image

    pil = Image.fromarray(rgb).convert("LAB")
    lab = np.asarray(pil)  # (H, W, 3) uint8
    lightness = lab[..., 0].astype(np.int32)
    a_star = lab[..., 1].astype(np.int32) - 128
    b_star = lab[..., 2].astype(np.int32) - 128
    chroma = np.sqrt(a_star * a_star + b_star * b_star)
    return (
        (chroma > FOOD_CHROMA_THRESHOLD)
        & (lightness > FOOD_LIGHTNESS_MIN)
        & (lightness < FOOD_LIGHTNESS_MAX)
    )
