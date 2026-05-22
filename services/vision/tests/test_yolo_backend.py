"""Tests for the YOLO segmentation backend.

Two flavours of test here:

1. Pure-function tests (always run): the consumption/confidence/suspicious
   math + notes formatting. These never touch ultralytics, so they run
   in every environment.

2. One model-conditional test that exercises a real YOLOv8n-seg inference
   end-to-end. It's auto-skipped when ultralytics + numpy + PIL aren't
   importable, so the suite stays green on the base venv.

What we deliberately don't test here: ultralytics' own behaviour. We
mock the model's predict() call when we want to test the integration
glue without paying for the weight download.
"""
from __future__ import annotations

import importlib.util

import pytest

from app.backends.base import BackendUnavailable
from app.backends.yolo import (
    YoloBackend,
    _confidence_from_stats,
    _consumption_from_stats,
    _format_notes,
    _is_suspicious,
    _SegmentStats,
)
from app.schemas import ExpectedDish

# ─── Pure-function tests ────────────────────────────────────────────────


def _stats(food: int = 0, total: int = 0, classes=None, confs=None) -> _SegmentStats:
    return _SegmentStats(
        food_pixels=food,
        total_pixels=total or max(food, 1),
        classes_seen=set(classes or []),
        detection_confidences=list(confs or []),
    )


def test_consumption_returns_zero_when_no_food_before():
    """No food detected in the 'before' frame → can't measure. Return 0
    consumption + ratio 1.0 so the suspicious gate fires below."""
    before = _stats(food=0)
    after = _stats(food=0)
    consumption, ratio = _consumption_from_stats(before, after)
    assert consumption == 0.0
    assert ratio == 1.0


def test_consumption_clean_plate():
    """All food gone → consumption 1.0."""
    consumption, ratio = _consumption_from_stats(_stats(food=1000), _stats(food=0))
    assert consumption == 1.0
    assert ratio == 0.0


def test_consumption_half_eaten():
    """Half the food remains → consumption 0.5."""
    consumption, ratio = _consumption_from_stats(_stats(food=1000), _stats(food=500))
    assert consumption == 0.5
    assert ratio == 0.5


def test_consumption_clamps_when_more_food_after():
    """More food after than before (anomalous) → consumption clamps to 0.
    The suspicious gate handles the alert."""
    consumption, ratio = _consumption_from_stats(_stats(food=500), _stats(food=750))
    assert consumption == 0.0
    assert ratio == 1.5


def test_confidence_averages_detection_scores():
    before = _stats(confs=[0.8, 0.9])
    after = _stats(confs=[0.7])
    # (0.8 + 0.9 + 0.7) / 3 = 0.8; both frames have detections, no penalty.
    assert _confidence_from_stats(before, after) == pytest.approx(0.8, abs=0.001)


def test_confidence_halved_when_one_frame_empty():
    """No qualifying detections in one frame → confidence drops by half.
    Sends the case to staff with a 'low confidence' banner."""
    before = _stats(confs=[0.9, 0.9])
    after = _stats(confs=[])
    assert _confidence_from_stats(before, after) == pytest.approx(0.45, abs=0.001)


def test_confidence_default_when_no_detections():
    """No detections in either frame → low fixed confidence."""
    assert _confidence_from_stats(_stats(), _stats()) == 0.2


def test_suspicious_flags_no_food_in_either_frame():
    """Wrong camera angle / non-food picture → suspicious."""
    assert _is_suspicious(_stats(food=0), _stats(food=0), ratio=1.0) is True


def test_suspicious_flags_more_food_after():
    """ratio > 1.3 → either wrong plate photographed or tampering."""
    assert _is_suspicious(_stats(food=1000), _stats(food=2000), ratio=2.0) is True


def test_not_suspicious_on_normal_consumption():
    assert _is_suspicious(_stats(food=1000), _stats(food=300), ratio=0.3) is False


def test_format_notes_lists_detected_classes():
    notes = _format_notes(
        _stats(food=1000, classes=["bowl", "bottle"]),
        _stats(food=200, classes=["bowl"]),
        ratio=0.2,
        suspicious=False,
    )
    assert "bottle, bowl" in notes  # alphabetised
    assert "1000 to 200" in notes
    assert "Suspicious" not in notes


def test_format_notes_appends_suspicious_reason():
    notes = _format_notes(
        _stats(food=0), _stats(food=0), ratio=1.0, suspicious=True
    )
    assert "Suspicious: no food detected in either frame" in notes


# ─── BackendUnavailable when deps missing ───────────────────────────────


def test_backend_raises_unavailable_without_deps(monkeypatch):
    """Force the import inside YoloBackend.__init__ to fail and check
    we surface the install hint, not a raw ImportError. Real instantiation
    when ultralytics is installed is covered by the conditional test below.
    """
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name in {"numpy", "ultralytics"} or name.startswith("ultralytics."):
            raise ImportError(f"simulated missing {name}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(BackendUnavailable) as excinfo:
        YoloBackend()
    assert ".[yolo]" in str(excinfo.value)


# ─── Conditional: real ultralytics path ─────────────────────────────────

_HAS_YOLO_DEPS = (
    importlib.util.find_spec("ultralytics") is not None
    and importlib.util.find_spec("numpy") is not None
    and importlib.util.find_spec("PIL") is not None
)


@pytest.mark.skipif(
    not _HAS_YOLO_DEPS,
    reason='YOLO extras not installed. `pip install -e ".[yolo]"` to enable.',
)
def test_infer_with_mocked_predict_assembles_inferout(monkeypatch):
    """End-to-end assembly with a mocked YOLO predict(). We avoid the
    weight download by patching _ensure_model + _segment_and_measure to
    return deterministic stats."""
    from app.backends import yolo as yolo_mod

    backend = YoloBackend()
    monkeypatch.setattr(backend, "_ensure_model", lambda: object())

    # Two different stats per call: pretend a meaningful drop in food pixels.
    calls = iter(
        [
            _stats(food=1000, classes=["bowl"], confs=[0.85]),
            _stats(food=200, classes=["bowl"], confs=[0.80]),
        ]
    )
    monkeypatch.setattr(
        yolo_mod, "_segment_and_measure", lambda model, image_bytes: next(calls)
    )

    # Image bytes content doesn't matter since we mocked _segment_and_measure.
    out = backend.infer(
        before_image=b"x",
        before_mime="image/png",
        after_image=b"y",
        after_mime="image/png",
        expected_dishes=[ExpectedDish(name="Butter Chicken", portion_size="regular")],
    )
    assert out.backend == "yolov8-seg"
    assert out.overall_consumption == pytest.approx(0.8, abs=0.001)
    assert out.confidence == pytest.approx(0.825, abs=0.01)
    assert out.suspicious is False
    assert len(out.per_item) == 1
    assert out.per_item[0].dish_name == "Butter Chicken"
    assert "1000 to 200" in out.notes
