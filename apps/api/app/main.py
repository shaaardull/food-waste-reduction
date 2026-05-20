from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import __version__
from app.config import get_settings
from app.errors import ApiError, envelope
from app.logging import configure_logging, get_logger
from app.routers import auth, dashboard, rewards, sessions, validations
from app.routers import restaurants as restaurants_router

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    configure_logging()
    log = get_logger("startup")
    log.info("api_starting", version=__version__, env=settings.NODE_ENV)
    yield
    log.info("api_stopping")


app = FastAPI(
    title="Plate-Clean Rewards API",
    version=__version__,
    description="Backend for the Plate-Clean Rewards PWA.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content=envelope(exc.code, exc.message, exc.details),
    )


@app.get("/health", tags=["meta"])
async def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


app.include_router(auth.router, prefix="/api/v1/auth", tags=["auth"])
app.include_router(restaurants_router.router, prefix="/api/v1/restaurants", tags=["restaurants"])
app.include_router(sessions.router, prefix="/api/v1/sessions", tags=["sessions"])
app.include_router(rewards.router, prefix="/api/v1/rewards", tags=["rewards"])
app.include_router(dashboard.router, prefix="/api/v1", tags=["dashboard"])
app.include_router(validations.router, prefix="/api/v1", tags=["validations"])
