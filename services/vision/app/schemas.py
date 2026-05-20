from pydantic import BaseModel, Field, HttpUrl


class ExpectedDish(BaseModel):
    name: str
    reference_image_url: HttpUrl | None = None
    portion_size: str | None = Field(default=None, pattern="^(small|regular|large)$")


class InferIn(BaseModel):
    before_image_url: HttpUrl
    after_image_url: HttpUrl
    expected_dishes: list[ExpectedDish] = Field(default_factory=list)


class PerItem(BaseModel):
    dish_name: str
    consumption: float = Field(ge=0.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)


class InferOut(BaseModel):
    """Matches CLAUDE.md §6.1 tool output. Returned identically by every backend."""

    overall_consumption: float = Field(ge=0.0, le=1.0)
    per_item: list[PerItem]
    confidence: float = Field(ge=0.0, le=1.0)
    notes: str
    suspicious: bool = False
    backend: str
    backend_version: str
    processing_ms: int
