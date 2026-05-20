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
