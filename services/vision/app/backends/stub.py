"""Deterministic stub backend. Used in dev and tests."""
from __future__ import annotations

import time

from app.backends.base import Backend
from app.schemas import ExpectedDish, InferOut, PerItem


class StubBackend(Backend):
    name = "stub"
    version = "1"

    def infer(
        self,
        before_image: bytes,
        before_mime: str,
        after_image: bytes,
        after_mime: str,
        expected_dishes: list[ExpectedDish],
    ) -> InferOut:
        start = time.perf_counter()
        # Pretend the diner consumed 80% of each ordered dish.
        per_item = [
            PerItem(dish_name=d.name, consumption=0.8, confidence=0.9) for d in expected_dishes
        ]
        overall = (
            sum(p.consumption for p in per_item) / len(per_item) if per_item else 0.8
        )
        processing_ms = int((time.perf_counter() - start) * 1000)
        return InferOut(
            overall_consumption=overall,
            per_item=per_item,
            confidence=0.9,
            notes="Stub backend — deterministic output for tests / dev.",
            suspicious=False,
            backend=self.name,
            backend_version=self.version,
            processing_ms=processing_ms,
        )
