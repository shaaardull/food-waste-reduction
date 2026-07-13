"""Render a downloadable sustainability-report PDF for a restaurant.

Phase 3 §9 bullet from CLAUDE.md. The PDF is a tangible artifact a
restaurant owner can hand to investors / put up at the front desk /
keep for their own records:

  ┌─────────────────────────────────────────────┐
  │  Plate-Clean Rewards         · generated …  │
  │  Sustainability report                       │
  │  Restaurant name · slug · range              │
  │                                              │
  │  [kg food]   [kg CO₂e]   [tree-days]         │
  │                                              │
  │  Activity (sessions / approved / rewards)    │
  │  Top dishes (table)                          │
  │  Methodology footer                          │
  └─────────────────────────────────────────────┘

Pure function — no I/O, no DB. The endpoint layer does the SQL and
feeds an Inputs dataclass into render_pdf(); this module's job is just
to turn that into bytes. Keeps the renderer trivially unit-testable
and lets us snapshot-diff layout changes in isolation.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from datetime import datetime

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas


@dataclass
class TopDish:
    name: str
    category: str | None
    orders: int
    avg_consumption: float  # 0..1


@dataclass
class ReportInputs:
    restaurant_name: str
    restaurant_slug: str
    period_days: int
    generated_at: datetime

    # Sustainability (per services.sustainability.compute)
    kg_food_saved: float
    kg_co2e_saved: float
    trees_day_equivalent: float
    sustainability_sessions_counted: int

    # Activity totals
    sessions: int
    approved: int
    adjusted: int
    rejected: int
    rewards_issued: int
    rewards_redeemed: int

    top_dishes: list[TopDish] = field(default_factory=list)


def render_pdf(inputs: ReportInputs) -> bytes:
    """Render the report and return PDF bytes. A4, single page (will
    extend to a second page if top_dishes is huge — unlikely in pilot
    sized data)."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    page_w, page_h = A4

    # Margins
    left = 20 * mm
    top = page_h - 20 * mm

    # ── Letterhead ──────────────────────────────────────────────────
    c.setFillColor(colors.HexColor("#0f766e"))  # brand teal
    c.setFont("Helvetica-Bold", 11)
    c.drawString(left, top, "Plate-Clean Rewards")
    c.setFillColor(colors.HexColor("#64748b"))
    c.setFont("Helvetica", 9)
    c.drawRightString(
        page_w - left,
        top,
        f"Generated {inputs.generated_at.strftime('%Y-%m-%d %H:%M UTC')}",
    )

    # Hairline
    c.setStrokeColor(colors.HexColor("#e2e8f0"))
    c.setLineWidth(0.5)
    c.line(left, top - 4 * mm, page_w - left, top - 4 * mm)

    # ── Title block ─────────────────────────────────────────────────
    y = top - 14 * mm
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 22)
    c.drawString(left, y, "Sustainability report")

    y -= 9 * mm
    c.setFont("Helvetica", 12)
    c.drawString(left, y, inputs.restaurant_name)
    c.setFillColor(colors.HexColor("#64748b"))
    c.setFont("Helvetica", 9)
    c.drawString(
        left, y - 4 * mm, f"{inputs.restaurant_slug} · last {inputs.period_days} days"
    )

    # ── Three big numbers ───────────────────────────────────────────
    y -= 18 * mm
    _draw_stat_grid(
        c,
        x=left,
        y=y,
        width=page_w - 2 * left,
        items=[
            (f"{inputs.kg_food_saved:.2f}", "kg food kept out of the bin"),
            (f"{inputs.kg_co2e_saved:.2f}", "kg CO₂e avoided"),
            (f"{inputs.trees_day_equivalent:.1f}", "tree-days equivalent"),
        ],
    )

    # ── Methodology blurb ───────────────────────────────────────────
    y -= 38 * mm
    c.setFillColor(colors.HexColor("#334155"))
    c.setFont("Helvetica-Oblique", 9)
    lines = [
        "We measure each diner's plate against a 60% restaurant baseline.",
        "Anything finished above that counts as food that didn't reach the bin.",
        "Carbon factor: 2.5 kg CO₂e per kg of cooked food (lifecycle-inclusive,",
        "mixed Indian-meal average). One mature tree absorbs ≈ 0.06 kg/day.",
    ]
    for line in lines:
        c.drawString(left, y, line)
        y -= 4.2 * mm

    # ── Activity ────────────────────────────────────────────────────
    y -= 4 * mm
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(left, y, "Activity in this window")
    y -= 6 * mm
    c.setFont("Helvetica", 10)
    redemption_pct = (
        100.0 * inputs.rewards_redeemed / inputs.rewards_issued
        if inputs.rewards_issued
        else 0.0
    )
    activity_lines = [
        f"{inputs.sessions} session(s) recorded",
        (
            f"{inputs.approved + inputs.adjusted} approved by staff "
            f"({inputs.approved} as-is + {inputs.adjusted} adjusted), "
            f"{inputs.rejected} rejected"
        ),
        (
            f"{inputs.rewards_issued} reward(s) issued · {inputs.rewards_redeemed} "
            f"redeemed ({redemption_pct:.0f}%)"
        ),
        f"{inputs.sustainability_sessions_counted} meal(s) counted in the impact figures above",
    ]
    for line in activity_lines:
        c.drawString(left + 4, y, f"• {line}")
        y -= 5 * mm

    # ── Top dishes table ────────────────────────────────────────────
    if inputs.top_dishes:
        y -= 4 * mm
        c.setFont("Helvetica-Bold", 11)
        c.drawString(left, y, "Top dishes by avg consumption (approved meals only)")
        y -= 6 * mm

        col_dish = left + 4
        col_cat = left + 90 * mm
        col_orders = left + 130 * mm
        col_score = left + 160 * mm

        c.setFont("Helvetica-Bold", 9)
        c.setFillColor(colors.HexColor("#64748b"))
        c.drawString(col_dish, y, "Dish")
        c.drawString(col_cat, y, "Category")
        c.drawRightString(col_orders + 10 * mm, y, "Orders")
        c.drawRightString(col_score + 10 * mm, y, "Avg")
        y -= 1.5 * mm
        c.line(left, y, page_w - left, y)
        y -= 4 * mm

        c.setFont("Helvetica", 10)
        c.setFillColor(colors.black)
        for dish in inputs.top_dishes[:5]:
            c.drawString(col_dish, y, _truncate(dish.name, 40))
            c.drawString(col_cat, y, dish.category or "—")
            c.drawRightString(col_orders + 10 * mm, y, str(dish.orders))
            c.drawRightString(
                col_score + 10 * mm, y, f"{round(dish.avg_consumption * 100)}%"
            )
            y -= 5 * mm
    else:
        y -= 4 * mm
        c.setFont("Helvetica-Oblique", 10)
        c.setFillColor(colors.HexColor("#64748b"))
        c.drawString(left, y, "No approved meals in this window yet.")
        y -= 5 * mm

    # ── Footer ──────────────────────────────────────────────────────
    c.setStrokeColor(colors.HexColor("#e2e8f0"))
    c.line(left, 20 * mm, page_w - left, 20 * mm)
    c.setFillColor(colors.HexColor("#64748b"))
    c.setFont("Helvetica", 8)
    c.drawString(
        left,
        15 * mm,
        "Generated by Plate-Clean Rewards · plateclean.in",
    )
    c.drawRightString(
        page_w - left,
        15 * mm,
        f"Report for {inputs.restaurant_slug}",
    )

    c.showPage()
    c.save()
    return buf.getvalue()


def _draw_stat_grid(
    c: canvas.Canvas,
    *,
    x: float,
    y: float,
    width: float,
    items: list[tuple[str, str]],
) -> None:
    """Three big-number cards laid out side by side, each ~50mm tall."""
    gap = 6 * mm
    box_w = (width - gap * (len(items) - 1)) / len(items)
    box_h = 32 * mm
    for i, (value, label) in enumerate(items):
        bx = x + i * (box_w + gap)
        c.setFillColor(colors.HexColor("#ecfdf5"))
        c.setStrokeColor(colors.HexColor("#a7f3d0"))
        c.roundRect(bx, y - box_h, box_w, box_h, 4 * mm, stroke=1, fill=1)
        c.setFillColor(colors.HexColor("#065f46"))
        c.setFont("Helvetica-Bold", 22)
        c.drawCentredString(bx + box_w / 2, y - 16 * mm, value)
        c.setFillColor(colors.HexColor("#047857"))
        c.setFont("Helvetica", 9)
        # Wrap label onto two lines if it's long.
        words = label.split()
        line1 = ""
        line2 = ""
        for w in words:
            candidate = (line1 + " " + w).strip()
            if c.stringWidth(candidate, "Helvetica", 9) < box_w - 6 * mm:
                line1 = candidate
            else:
                line2 = (line2 + " " + w).strip()
        c.drawCentredString(bx + box_w / 2, y - 24 * mm, line1)
        if line2:
            c.drawCentredString(bx + box_w / 2, y - 28 * mm, line2)


def _truncate(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"
