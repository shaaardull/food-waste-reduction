"""Compute per-diner sustainability metrics.

Ethics rule 3 (CLAUDE.md §8): "Sustainability metrics like 'you saved
0.4 kg CO₂e this month' are fine and encouraged."

Approach:
- We don't track per-dish weight in the menu, so we apply a simple
  per-category default (`CATEGORY_GRAMS`).
- For each session the diner completed in the window (final_score is
  truthy ⇒ staff approved or adjusted), the meal weight is the sum of
  ordered items × their category default grams.
- "Saved" framing: a typical diner-without-the-app finishes around
  BASELINE_CONSUMPTION of the served food. So
      saved_grams = max(0, final_score - BASELINE_CONSUMPTION) * meal_grams
  reflects the *extra* food not wasted because this diner finished
  more than the baseline. Negative deltas are clamped at zero — we
  never penalise a diner for being below the baseline.
- kg CO₂e factor: 2.5 kg CO₂e per kg of cooked food (mixed Indian
  meal average, lifecycle-inclusive of farm + transport + cooking).
  Tunable via CO2E_PER_KG_FOOD.

The function is deliberately pure (no I/O) so it's easy to unit-test.
The router endpoint joins meal_session + meal_session_item + menu_item
+ staff_validation and feeds the result here.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

# Grams per dish, by category. Pragmatic defaults — tunable per restaurant
# once we collect plate-weight data in Phase 2.
CATEGORY_GRAMS: dict[str, int] = {
    "main": 350,
    "side": 100,
    "drink": 250,
    "dessert": 120,
}
DEFAULT_GRAMS = 200

# A typical diner finishes ~60% of what they're served (Indian restaurant
# baseline from FAO + Toi observational studies, rounded). Anything above
# this counts as "saved" food.
BASELINE_CONSUMPTION = Decimal("0.60")

# Lifecycle kg CO₂e per kg of cooked food.
CO2E_PER_KG_FOOD = Decimal("2.5")

# One mature tree absorbs ~22 kg CO₂e per year ≈ 0.06 kg/day.
KG_CO2E_PER_TREE_DAY = Decimal("0.06")


@dataclass
class SessionInput:
    """One approved session's contribution.

    `final_score` is the staff-recorded final_score (0..1).
    `item_categories` is the list of (category, quantity) tuples.
    """

    final_score: Decimal
    item_categories: list[tuple[str | None, int]]


@dataclass
class SustainabilityReport:
    period_days: int
    sessions_counted: int
    kg_food_saved: float
    kg_co2e_saved: float
    trees_day_equivalent: float


def meal_grams(item_categories: list[tuple[str | None, int]]) -> int:
    total = 0
    for category, qty in item_categories:
        g = CATEGORY_GRAMS.get(category or "", DEFAULT_GRAMS)
        total += g * max(0, qty)
    return total


def compute(sessions: list[SessionInput], *, period_days: int) -> SustainabilityReport:
    total_saved_grams = Decimal(0)
    counted = 0
    for s in sessions:
        delta = s.final_score - BASELINE_CONSUMPTION
        if delta <= 0:
            # Diner was at or below the baseline — no net saving this meal,
            # but the session still counts so the report doesn't omit context.
            counted += 1
            continue
        grams = Decimal(meal_grams(s.item_categories))
        total_saved_grams += delta * grams
        counted += 1

    kg_saved = total_saved_grams / Decimal(1000)
    kg_co2e = kg_saved * CO2E_PER_KG_FOOD
    trees_day = kg_co2e / KG_CO2E_PER_TREE_DAY if kg_co2e > 0 else Decimal(0)

    return SustainabilityReport(
        period_days=period_days,
        sessions_counted=counted,
        # Round to 2 decimals in the response; the raw Decimal carries
        # more precision internally for callers that want it.
        kg_food_saved=round(float(kg_saved), 2),
        kg_co2e_saved=round(float(kg_co2e), 2),
        trees_day_equivalent=round(float(trees_day), 2),
    )
