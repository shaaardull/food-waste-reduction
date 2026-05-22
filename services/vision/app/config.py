from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env", "../../.env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    NODE_ENV: Literal["development", "test", "staging", "production"] = "development"
    LOG_LEVEL: str = "info"

    # 'stub' is the default so the service runs out-of-the-box for tests
    # and local dev. 'anthropic' wraps the Phase 1 Claude call; 'yolo' is
    # the Phase 2 target backend (gated on the `yolo` extras install).
    VISION_BACKEND: Literal["stub", "anthropic", "yolo"] = "stub"

    # Anthropic backend config
    ANTHROPIC_API_KEY: str = ""
    VISION_MODEL: str = "claude-sonnet-4-5"
    VISION_TIMEOUT_SECONDS: int = 30

    # Image-fetch knobs
    IMAGE_FETCH_TIMEOUT_SECONDS: int = 10
    MAX_IMAGE_BYTES: int = 5 * 1024 * 1024

    # Yolo backend config. Empty string ⇒ "yolov8n-seg.pt" (the default
    # COCO-pretrained nano segmentation model, ~7 MB, auto-downloaded by
    # ultralytics on first inference). Override with an absolute path to
    # a locally-trained model once we have fine-tuned weights.
    YOLO_MODEL_PATH: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
