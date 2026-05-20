"""Perceptual-hash continuity check between before/after captures.

Fraud signal #6 (CLAUDE.md §7): the non-food area of the plate/table must look
the same in both images. We approximate "non-food" by phashing the frame around
the center crop — diners typically center the plate, so the food sits in the
middle and tablecloth / table edge / utensils sit around the perimeter. A diner
swapping in an unrelated photo will have a totally different frame.

Threshold (Hamming distance) is configurable but defaults to 8 per the spec.
"""
from __future__ import annotations

import io
from dataclasses import dataclass

import imagehash
from PIL import Image

# Width of the perimeter strip we use as "the non-food frame", in pixels of a
# normalized 512×512 input.
BORDER_PX = 96
NORM_SIZE = 512
DEFAULT_MAX_HAMMING_DISTANCE = 8


@dataclass
class PhashResult:
    distance: int
    matched: bool
    before_hash: str
    after_hash: str


def _frame_of(image_bytes: bytes) -> Image.Image:
    """Compose a synthetic image from only the perimeter strips of the input.

    The four border bands (top, bottom, left, right) are concatenated into a
    single rectangle. The food in the middle of the original image is dropped
    entirely, so the resulting phash reflects table / plate-edge / surroundings.
    """
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    img = img.resize((NORM_SIZE, NORM_SIZE), Image.Resampling.LANCZOS)
    b = BORDER_PX
    top = img.crop((0, 0, NORM_SIZE, b))
    bottom = img.crop((0, NORM_SIZE - b, NORM_SIZE, NORM_SIZE))
    left = img.crop((0, b, b, NORM_SIZE - b)).rotate(90, expand=True)
    right = img.crop((NORM_SIZE - b, b, NORM_SIZE, NORM_SIZE - b)).rotate(-90, expand=True)
    # Stack vertically: top | left | right | bottom — same total area each time,
    # so phash sees a stable signature whenever the perimeter looks the same.
    out = Image.new("RGB", (NORM_SIZE, b * 4))
    out.paste(top, (0, 0))
    out.paste(left, (0, b))
    out.paste(right, (0, b * 2))
    out.paste(bottom, (0, b * 3))
    return out


def continuity_check(
    before_bytes: bytes,
    after_bytes: bytes,
    *,
    max_distance: int = DEFAULT_MAX_HAMMING_DISTANCE,
) -> PhashResult:
    """Compare the non-food frame phashes. Returns matched=True if Hamming distance ≤ max."""
    bh = imagehash.phash(_frame_of(before_bytes))
    ah = imagehash.phash(_frame_of(after_bytes))
    distance = bh - ah
    return PhashResult(
        distance=int(distance),
        matched=int(distance) <= max_distance,
        before_hash=str(bh),
        after_hash=str(ah),
    )
