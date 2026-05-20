"""Smoke tests for app.services.phash.

We don't need real plate photos — synthetic gradients with a center crop
swapped out exercise the same code path. The continuity check should:
  - report matched=True when before/after share the same frame, even when
    the center (food region) differs.
  - report matched=False when the frame is unrelated.
"""
from __future__ import annotations

import io

from PIL import Image, ImageDraw

from app.services.phash import continuity_check


def _scene(
    perimeter_color: tuple[int, int, int],
    food_color: tuple[int, int, int],
    pattern: str = "grid",
) -> bytes:
    """Build a 512×512 image: a colored 'table' perimeter with a circular 'plate'
    in the center. `pattern` controls the perimeter texture: 'grid', 'horizontal',
    'diagonal', or 'plain' — used to simulate different tables."""
    img = Image.new("RGB", (512, 512), perimeter_color)
    draw = ImageDraw.Draw(img)
    fg = (max(0, perimeter_color[0] - 80), 60, 60)
    if pattern == "grid":
        for i in range(0, 512, 32):
            draw.line([(i, 0), (i, 512)], fill=fg, width=2)
            draw.line([(0, i), (512, i)], fill=fg, width=2)
    elif pattern == "horizontal":
        for i in range(0, 512, 16):
            draw.line([(0, i), (512, i)], fill=fg, width=4)
    elif pattern == "diagonal":
        for i in range(-512, 1024, 24):
            draw.line([(i, 0), (i + 512, 512)], fill=fg, width=3)
    # 'plain' = no perimeter texture.
    # Centered "plate": a 140-radius circle inside the 320×320 non-border zone
    # so the plate edge never bleeds into the perimeter strip the phash looks at.
    cx, cy = 256, 256
    r = 140
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=food_color, outline=(255, 255, 255), width=4)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_continuity_matches_when_frame_is_same():
    # Same tabletop, very different food (full plate of curry vs nearly empty).
    before = _scene(perimeter_color=(180, 90, 60), food_color=(220, 180, 50))
    after = _scene(perimeter_color=(180, 90, 60), food_color=(90, 90, 90))
    result = continuity_check(before, after, max_distance=8)
    assert result.matched, (
        f"expected match, got distance={result.distance} "
        f"before={result.before_hash} after={result.after_hash}"
    )


def test_continuity_rejects_when_frame_differs():
    # Different tabletop pattern entirely — grid vs diagonal stripes — that's a
    # different table.
    before = _scene(perimeter_color=(180, 90, 60), food_color=(200, 100, 100), pattern="grid")
    after = _scene(perimeter_color=(40, 200, 220), food_color=(200, 100, 100), pattern="diagonal")
    result = continuity_check(before, after, max_distance=8)
    assert not result.matched, (
        f"expected non-match, got distance={result.distance} "
        f"before={result.before_hash} after={result.after_hash}"
    )


def test_continuity_result_has_string_hashes():
    base = _scene(perimeter_color=(120, 130, 140), food_color=(220, 180, 50))
    result = continuity_check(base, base)
    assert isinstance(result.before_hash, str)
    assert isinstance(result.after_hash, str)
    assert result.distance == 0
    assert result.matched
