from functools import lru_cache
from typing import Literal

from pydantic import Field
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

    DATABASE_URL: str = "postgresql+asyncpg://plate:plate@localhost:5432/plate_clean"
    DATABASE_URL_SYNC: str = "postgresql://plate:plate@localhost:5432/plate_clean"
    REDIS_URL: str = "redis://localhost:6379/0"

    JWT_SECRET: str = Field(default="dev_secret_change_me_min_32_chars_xxxx", min_length=32)
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRY_HOURS: int = 24
    OTP_PROVIDER: Literal["console", "msg91", "twilio"] = "console"
    OTP_API_KEY: str = ""

    # ── msg91 (Indian DLT-compliant SMS gateway) ─────────────────────
    # Every SMS template must be pre-registered on TRAI's DLT portal
    # under a Principal Entity, then linked to a msg91 Flow whose ID
    # is what these env vars hold. Same auth key for all templates.
    # In dev with OTP_PROVIDER=console these are ignored — SMS just
    # logs to stdout. In prod flip OTP_PROVIDER=msg91 and fill these.
    MSG91_AUTH_KEY: str = ""
    # DLT-approved 6-char sender ID (e.g. "PLTCLN"). msg91 falls back
    # to the account's default sender when empty.
    MSG91_SENDER_ID: str = ""
    # Base URL — knob so tests can point at a mock server.
    MSG91_BASE_URL: str = "https://control.msg91.com"
    # One template per transactional message class. Each maps to a
    # Flow ID configured in the msg91 dashboard with the variables
    # (##var1##, ##var2##, ...) documented on the client functions.
    MSG91_OTP_TEMPLATE_ID: str = ""
    MSG91_RESET_TEMPLATE_ID: str = ""
    MSG91_REWARD_TEMPLATE_ID: str = ""
    MSG91_BILL_TEMPLATE_ID: str = ""
    # HTTP timeout for msg91 calls. Kept short so a slow gateway
    # doesn't block the reset/login OTP inline path for the diner.
    MSG91_TIMEOUT_SECONDS: int = 8

    # ── Email (Gap-D bill delivery) ─────────────────────────────────
    # `console` logs the rendered message to stdout (matches the OTP
    # pattern for dev), `smtp` actually opens a connection. If SMTP
    # is misconfigured on a `smtp` build we fall back to logging with
    # an error rather than crashing the delivery task.
    EMAIL_MODE: Literal["console", "smtp"] = "console"
    SMTP_HOST: str = "smtp.zoho.in"
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_STARTTLS: bool = True
    EMAIL_FROM_NAME: str = "Plate-Clean Rewards"
    EMAIL_FROM_ADDRESS: str = ""  # falls back to SMTP_USER if blank
    # Where diner-filed disputes get emailed. Configurable so ops can
    # point it at a Zendesk / Freshdesk drop address later without a
    # code change.
    SUPPORT_EMAIL_ADDRESS: str = "support-platecleanrewards@superpositionlabs.co.in"
    # Google Identity Services OAuth Client ID. When empty, the
    # /auth/google endpoint responds 503 (feature not configured);
    # when set, that's the audience the incoming ID token must match.
    # The FRONTEND uses the SAME client ID via VITE_GOOGLE_CLIENT_ID.
    # Provision one at https://console.cloud.google.com → Credentials
    # → Create OAuth Client ID → Web application, with authorized
    # JavaScript origins for each app port (5173/5174/5175) in dev
    # and the prod domains later.
    GOOGLE_CLIENT_ID: str = ""
    # Used in dispute-notification emails as a deep-link target — a
    # single knob so we don't hardcode "http://localhost:5174" in a
    # template. Override in prod via env.
    DASHBOARD_BASE_URL: str = "http://localhost:5174"

    S3_ENDPOINT: str = "http://localhost:9000"
    S3_REGION: str = "us-east-1"
    S3_BUCKET: str = "plate-clean-images"
    S3_ACCESS_KEY: str = "minioadmin"
    S3_SECRET_KEY: str = "minioadmin"  # noqa: S105 -- dev-only default, real value via env
    S3_PUBLIC_BASE_URL: str = "http://localhost:9000"

    ANTHROPIC_API_KEY: str = ""
    VISION_MODEL: str = "claude-sonnet-4-5"
    VISION_TIMEOUT_SECONDS: int = 30

    # Phase 2: when set, the scoring task posts to services/vision instead of
    # calling Anthropic in-process. Wire the URL and flip the flag to migrate.
    USE_VISION_SERVICE: bool = False
    VISION_SERVICE_URL: str = "http://localhost:8001"
    VISION_SERVICE_TIMEOUT_SECONDS: int = 30

    GEOFENCE_DEFAULT_RADIUS_M: int = 100
    GEOFENCE_MODE: Literal["warn", "block"] = "warn"
    MAX_SESSIONS_PER_USER_PER_DAY: int = 3
    MAX_CAPTURES_PER_HOUR: int = 10
    MAX_REWARDS_PER_RESTAURANT_PER_DAY: int = 1
    # OTP-cost defence: msg91/Twilio bills per SMS, so an attacker
    # who scrapes a phone list can rack up thousands of ₹ overnight
    # without these limits. Bucketed by identifier (phone for OTP
    # login, email-or-phone for password reset).
    MAX_OTP_REQUESTS_PER_HOUR: int = 5
    MAX_OTP_REQUESTS_PER_DAY: int = 15

    NONCE_BEFORE_TTL_MINUTES: int = 15
    NONCE_AFTER_TTL_MINUTES: int = 30
    SESSION_TTL_HOURS: int = 4
    MIN_MINUTES_BETWEEN_CAPTURES: int = 5
    # §12 reward window: full value within 15 days; half value days 16-30; expired after.
    REWARD_FULL_VALUE_DAYS: int = 15
    REWARD_EXPIRY_DAYS: int = 30

    CORS_ORIGINS: str = "http://localhost:5173,http://localhost:5174"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
