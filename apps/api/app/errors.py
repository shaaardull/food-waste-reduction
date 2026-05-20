from typing import Any

from fastapi import HTTPException, status


class ApiError(HTTPException):
    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(status_code=status_code, detail=message)
        self.code = code
        self.message = message
        self.details = details or {}


def envelope(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details or {}}}


class InvalidNonce(ApiError):
    def __init__(self, details: dict[str, Any] | None = None) -> None:
        super().__init__(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="INVALID_NONCE",
            message="The capture nonce is invalid, expired, or already used.",
            details=details,
        )


class SessionExpired(ApiError):
    def __init__(self) -> None:
        super().__init__(
            status_code=status.HTTP_410_GONE,
            code="SESSION_EXPIRED",
            message="This meal session has expired.",
        )


class WrongSessionStatus(ApiError):
    def __init__(self, expected: str | list[str], actual: str) -> None:
        super().__init__(
            status_code=status.HTTP_409_CONFLICT,
            code="WRONG_SESSION_STATUS",
            message="The session is not in the expected status for this action.",
            details={"expected": expected, "actual": actual},
        )


class GeofenceViolation(ApiError):
    def __init__(self, distance_m: float, max_m: int) -> None:
        super().__init__(
            status_code=status.HTTP_403_FORBIDDEN,
            code="GEOFENCE_VIOLATION",
            message="Capture location is outside restaurant geofence.",
            details={"distance_m": distance_m, "max_m": max_m},
        )


class DuplicateCapture(ApiError):
    def __init__(self) -> None:
        super().__init__(
            status_code=status.HTTP_409_CONFLICT,
            code="DUPLICATE_CAPTURE",
            message="A capture already exists for this session and phase.",
        )


class RateLimited(ApiError):
    def __init__(self, details: dict[str, Any] | None = None) -> None:
        super().__init__(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            code="RATE_LIMITED",
            message="You're doing that too often. Please try again later.",
            details=details,
        )


class InsufficientPermissions(ApiError):
    def __init__(self) -> None:
        super().__init__(
            status_code=status.HTTP_403_FORBIDDEN,
            code="INSUFFICIENT_PERMISSIONS",
            message="You do not have permission to perform this action.",
        )


class NotRestaurantStaff(ApiError):
    def __init__(self) -> None:
        super().__init__(
            status_code=status.HTTP_403_FORBIDDEN,
            code="NOT_RESTAURANT_STAFF",
            message="You are not staff at this restaurant.",
        )


class ModelUnavailable(ApiError):
    def __init__(self) -> None:
        super().__init__(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="MODEL_UNAVAILABLE",
            message="The vision model is temporarily unavailable.",
        )


class ImageTooLarge(ApiError):
    def __init__(self, max_bytes: int) -> None:
        super().__init__(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            code="IMAGE_TOO_LARGE",
            message="The uploaded image exceeds the maximum allowed size.",
            details={"max_bytes": max_bytes},
        )


class ImageInvalid(ApiError):
    def __init__(self, reason: str) -> None:
        super().__init__(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="IMAGE_INVALID",
            message="The uploaded image is invalid.",
            details={"reason": reason},
        )


class ValidationAlreadyDecided(ApiError):
    def __init__(self) -> None:
        super().__init__(
            status_code=status.HTTP_409_CONFLICT,
            code="VALIDATION_ALREADY_DECIDED",
            message="A staff decision has already been recorded for this session.",
        )


class ValidationRequiresFinalScore(ApiError):
    def __init__(self) -> None:
        super().__init__(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="VALIDATION_REQUIRES_FINAL_SCORE",
            message="An 'adjusted' decision requires final_score.",
        )


class ValidationRequiresReasonCode(ApiError):
    def __init__(self) -> None:
        super().__init__(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="VALIDATION_REQUIRES_REASON_CODE",
            message="This decision requires a reason_code.",
        )
