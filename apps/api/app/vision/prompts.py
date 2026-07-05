SYSTEM_PROMPT = """\
You are analyzing two photos of a restaurant plate.
- Image 1 was taken BEFORE the meal (food as served).
- Image 2 was taken AFTER the meal (what remains).

Your task: estimate the fraction of food consumed.

Rules:
- Distinguish edible food remaining from non-edible residue (bones, shells, peels, sauce smears).
- Report per-dish consumption when possible; otherwise an overall figure.
- Confidence reflects image quality, occlusion, and ambiguity, not your model's general capability.
- Set "suspicious" true if the after-image is clearly a different plate, location, or scene.
- Be conservative on dish identification: if the after-image is too blurry or off-angle to be sure,
  lower confidence rather than guessing.

Return only the report_consumption tool call.
"""


def build_user_prompt(ordered_items_yaml: str) -> str:
    return (
        "The ordered items are:\n"
        f"{ordered_items_yaml}\n\n"
        "Analyze the two images and call the report_consumption tool."
    )


EXTRACT_MENU_SYSTEM_PROMPT = """\
You are looking at a photograph of a restaurant menu card. Your task
is to extract every dish row that is visible into a structured list
the staff will review and confirm before it enters the point-of-sale.

Rules:
- One row per distinct dish. Do NOT merge multiple size variants into
  one row.
- If a dish is printed with multiple sizes (Half/Full, S/M/L,
  Regular/Large), report ONE row per dish using the SMALLEST-size
  price, and mention the size variants in `notes` so staff can add
  the other sizes manually.
- Prices are integers in paise (₹1 = 100 paise). ₹150 → 15000.
  ₹1,240 → 124000. If the price is unclear or missing, use 0 and
  drop that row's confidence below 0.4 so the staff review flags it.
- Categorize each dish into exactly one of:
  starter, main, side, bread, drink, dessert. If the menu has
  explicit section headings (e.g. "Starters", "Mains", "Desserts"),
  use those. Otherwise infer from the dish name.
- Confidence per row matters. Blurred, cropped, or ambiguous rows
  MUST have confidence < 0.75. Staff will double-check every
  low-confidence row, so it's better to surface uncertainty than to
  guess.
- If both English and Devanagari (Hindi / Marathi) names appear
  side-by-side, prefer the English / Latin-transliterated name.
- Do NOT invent items that aren't visible on the card. If unsure,
  leave the item out and mention the omission in `notes`.

The pilot restaurants serve North Indian and coastal Konkan cuisine
in INR. Default `detected_currency` to "INR" unless the card clearly
shows another symbol.

Return only the extract_menu tool call.
"""


EXTRACT_MENU_TOOL = {
    "name": "extract_menu",
    "description": (
        "Extract every dish row from a photograph of a restaurant menu card."
    ),
    "input_schema": {
        "type": "object",
        "required": ["items", "detected_currency", "confidence"],
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["name", "price_minor", "category", "confidence"],
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": (
                                "Dish name as printed. If both Latin and Devanagari "
                                "variants appear, prefer the Latin version."
                            ),
                        },
                        "description": {
                            "type": "string",
                            "description": (
                                "Short blurb if the menu prints one; empty otherwise."
                            ),
                        },
                        "price_minor": {
                            "type": "integer",
                            "description": (
                                "Price in paise. If multiple sizes are shown, use "
                                "the smallest. If unreadable, use 0 with low "
                                "confidence."
                            ),
                        },
                        "category": {
                            "type": "string",
                            "enum": [
                                "starter",
                                "main",
                                "side",
                                "bread",
                                "drink",
                                "dessert",
                            ],
                        },
                        "confidence": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1,
                            "description": (
                                "Row-level confidence. Blurred / cropped rows "
                                "MUST be < 0.75."
                            ),
                        },
                    },
                },
            },
            "detected_currency": {
                "type": "string",
                "description": (
                    "ISO 4217 code inferred from currency symbols on the card. "
                    "Default INR."
                ),
            },
            "confidence": {
                "type": "number",
                "minimum": 0,
                "maximum": 1,
                "description": (
                    "Overall extraction confidence. Low if the photo is "
                    "blurred, angled, or cropped."
                ),
            },
            "notes": {
                "type": "string",
                "description": (
                    "Anything ambiguous: cropped rows, multi-size dishes, "
                    "multi-language sections, glare, mixed currencies."
                ),
            },
        },
    },
}


TOOL_DEFINITION = {
    "name": "report_consumption",
    "description": "Report per-dish consumption analysis from before/after plate images.",
    "input_schema": {
        "type": "object",
        "required": ["overall_consumption", "per_item", "confidence", "notes"],
        "properties": {
            "overall_consumption": {
                "type": "number",
                "minimum": 0,
                "maximum": 1,
                "description": "Estimated fraction of served food consumed (0=untouched, 1=clean plate).",
            },
            "per_item": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["dish_name", "consumption", "confidence"],
                    "properties": {
                        "dish_name": {"type": "string"},
                        "consumption": {"type": "number", "minimum": 0, "maximum": 1},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    },
                },
            },
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "notes": {
                "type": "string",
                "description": (
                    "Any observations: occlusion, lighting issues, suspicious patterns, "
                    "mismatched dishes."
                ),
            },
            "suspicious": {
                "type": "boolean",
                "description": (
                    "Set true if the after-image appears unrelated to the before-image "
                    "or shows tampering."
                ),
            },
        },
    },
}
