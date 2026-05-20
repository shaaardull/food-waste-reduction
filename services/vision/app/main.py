import logging
import sys
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, HTTPException, status
from fastapi.responses import JSONResponse

from app import __version__
from app.backends import BackendUnavailable, get_backend
from app.config import get_settings
from app.fetch import fetch_image
from app.schemas import InferIn, InferOut

settings = get_settings()


def _configure_logging() -> None:
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO),
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer()
            if settings.NODE_ENV != "development"
            else structlog.dev.ConsoleRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
    )


log = structlog.get_logger("vision")


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    _configure_logging()
    log.info("vision_starting", version=__version__, backend=settings.VISION_BACKEND)
    yield
    log.info("vision_stopping")


app = FastAPI(
    title="Plate-Clean Vision Service",
    version=__version__,
    description="Standalone vision-inference microservice (CLAUDE.md §6.2).",
    lifespan=lifespan,
)


@app.exception_handler(BackendUnavailable)
async def backend_unavailable_handler(_, exc: BackendUnavailable) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content={
            "error": {
                "code": "MODEL_UNAVAILABLE",
                "message": str(exc),
            }
        },
    )


@app.get("/health", tags=["meta"])
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "version": __version__,
        "backend": settings.VISION_BACKEND,
    }


@app.post("/infer", response_model=InferOut, tags=["inference"])
async def infer(payload: InferIn) -> InferOut:
    try:
        before_bytes, before_mime = await fetch_image(str(payload.before_image_url))
        after_bytes, after_mime = await fetch_image(str(payload.after_image_url))
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": {"code": "IMAGE_INVALID", "message": str(exc)}},
        ) from exc

    backend = get_backend()
    return backend.infer(
        before_bytes,
        before_mime,
        after_bytes,
        after_mime,
        payload.expected_dishes,
    )
