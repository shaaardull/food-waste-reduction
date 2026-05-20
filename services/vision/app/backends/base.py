from abc import ABC, abstractmethod

from app.schemas import ExpectedDish, InferOut


class BackendUnavailable(Exception):
    """Raised when a backend's dependencies aren't installed or its remote
    is down. The API layer converts this to HTTP 503."""


class Backend(ABC):
    """Interface that every inference backend implements.

    Phase 1 used the Anthropic backend inline inside apps/api. Phase 2
    extracts that into this microservice and adds a yolo backend; the
    contract stays identical so the rest of the system doesn't need to
    change when we swap implementations.
    """

    name: str = "base"
    version: str = "0"

    @abstractmethod
    def infer(
        self,
        before_image: bytes,
        before_mime: str,
        after_image: bytes,
        after_mime: str,
        expected_dishes: list[ExpectedDish],
    ) -> InferOut:
        """Run inference and return a normalized InferOut.

        Implementations must populate `backend`, `backend_version`, and
        `processing_ms` on the returned object.
        """
