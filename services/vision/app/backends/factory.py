from functools import lru_cache

from app.backends.anthropic import AnthropicBackend
from app.backends.base import Backend, BackendUnavailable
from app.backends.stub import StubBackend
from app.backends.yolo import YoloBackend
from app.config import get_settings


@lru_cache
def get_backend() -> Backend:
    name = get_settings().VISION_BACKEND
    if name == "stub":
        return StubBackend()
    if name == "anthropic":
        return AnthropicBackend()
    if name == "yolo":
        return YoloBackend()
    raise BackendUnavailable(f"unknown VISION_BACKEND={name}")
