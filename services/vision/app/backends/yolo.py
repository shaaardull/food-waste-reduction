"""YOLOv11-seg backend stub.

This file deliberately doesn't import torch/ultralytics — those are heavy
deps only installed via the `yolo` extras. The actual model wiring lives
here for Phase 2 once we have labeled data; for now, instantiation raises
BackendUnavailable so the service falls back or returns 503.
"""
from __future__ import annotations

from app.backends.base import Backend, BackendUnavailable
from app.schemas import ExpectedDish, InferOut


class YoloBackend(Backend):
    name = "yolov11-seg"
    version = "0"

    def __init__(self) -> None:
        # TODO(decision): wire torch + ultralytics here when the model is trained.
        # `pip install -e ".[yolo]"` brings the deps in.
        raise BackendUnavailable(
            "YOLO backend not yet implemented — train and ship the model first."
        )

    def infer(
        self,
        before_image: bytes,
        before_mime: str,
        after_image: bytes,
        after_mime: str,
        expected_dishes: list[ExpectedDish],
    ) -> InferOut:
        raise BackendUnavailable("YOLO backend not yet implemented")
