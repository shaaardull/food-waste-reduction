"""Shared test fixtures.

Strategy:
  - Tests share a single Postgres + Redis (the same instances the dev API
    uses). Each test creates fresh users / restaurants prefixed with a
    unique run-id and cleans up after itself.
  - The S3 client is monkey-patched to an in-memory dict for capture tests,
    so we don't need MinIO running.
  - The Celery scoring task is patched to run inline (no broker required)
    and returns a deterministic score.
  - The Anthropic call is never hit; the patched scoring task short-circuits.
"""
from __future__ import annotations

import asyncio
import io
import os
import uuid
from collections.abc import AsyncIterator, Iterator
from datetime import UTC
from decimal import Decimal

import pytest
import pytest_asyncio
from PIL import Image
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

os.environ.setdefault("NODE_ENV", "test")
os.environ.setdefault("JWT_SECRET", "test_secret_test_secret_test_secret_test_x")
os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://plate:plate@localhost:5432/plate_clean"
)
os.environ.setdefault(
    "DATABASE_URL_SYNC", "postgresql://plate:plate@localhost:5432/plate_clean"
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")


# Per-test-run prefix used in every email / slug / table_code we create so
# parallel runs and rerun-after-failure don't collide.
RUN_TAG = uuid.uuid4().hex[:8]


def make_email(local_part: str) -> str:
    return f"itest-{RUN_TAG}-{local_part}-{uuid.uuid4().hex[:6]}@example.com"


def make_phone() -> str:
    # E.164-ish Indian mobile with a unique-per-test 8-digit body — the
    # +91 prefix keeps parsing consistent with the OTP endpoints.
    return f"+919{uuid.uuid4().int % 10**9:09d}"


def make_slug(name: str) -> str:
    return f"itest-{RUN_TAG}-{name}-{uuid.uuid4().hex[:6]}"


def make_table_code(name: str) -> str:
    return f"ITEST-{RUN_TAG}-{name}-{uuid.uuid4().hex[:4]}"


@pytest.fixture(scope="session")
def event_loop() -> Iterator[asyncio.AbstractEventLoop]:
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def db() -> Iterator[Session]:
    """Sync session for test setup (creating users/restaurants/menu items).

    The actual API uses the async session; this fixture is just for fixture
    construction & cleanup. Cleanup runs after the test using the same
    prefixes baked into the fixture helpers.
    """
    from app.config import get_settings

    engine = create_engine(get_settings().DATABASE_URL_SYNC, future=True)
    with Session(engine, future=True) as session:
        yield session
        session.rollback()


@pytest.fixture(autouse=True)
def cleanup_run_artifacts() -> Iterator[None]:
    """Remove every row this test created. Uses RUN_TAG prefixes."""
    yield
    from app.config import get_settings

    engine = create_engine(get_settings().DATABASE_URL_SYNC, future=True)
    with Session(engine, future=True) as s:
        # Order matters: respect FK constraints.
        s.execute(
            text("DELETE FROM fraud_signals WHERE user_id IN "
                 "(SELECT id FROM users WHERE email LIKE :p)").bindparams(
                p=f"itest-{RUN_TAG}-%"
            )
        )
        s.execute(
            text("DELETE FROM fraud_signals WHERE meal_session_id IN "
                 "(SELECT id FROM meal_sessions WHERE table_code LIKE :p)").bindparams(
                p=f"ITEST-{RUN_TAG}-%"
            )
        )
        s.execute(
            text("DELETE FROM disputes WHERE meal_session_id IN "
                 "(SELECT id FROM meal_sessions WHERE table_code LIKE :p)").bindparams(
                p=f"ITEST-{RUN_TAG}-%"
            )
        )
        s.execute(
            text("DELETE FROM rewards WHERE meal_session_id IN "
                 "(SELECT id FROM meal_sessions WHERE table_code LIKE :p)").bindparams(
                p=f"ITEST-{RUN_TAG}-%"
            )
        )
        s.execute(
            text("DELETE FROM staff_validations WHERE meal_session_id IN "
                 "(SELECT id FROM meal_sessions WHERE table_code LIKE :p)").bindparams(
                p=f"ITEST-{RUN_TAG}-%"
            )
        )
        s.execute(
            text("DELETE FROM staff_metrics_snapshots WHERE staff_user_id IN "
                 "(SELECT id FROM users WHERE email LIKE :p)").bindparams(
                p=f"itest-{RUN_TAG}-%"
            )
        )
        s.execute(
            text("DELETE FROM consumption_scores WHERE meal_session_id IN "
                 "(SELECT id FROM meal_sessions WHERE table_code LIKE :p)").bindparams(
                p=f"ITEST-{RUN_TAG}-%"
            )
        )
        s.execute(
            text("DELETE FROM plate_captures WHERE meal_session_id IN "
                 "(SELECT id FROM meal_sessions WHERE table_code LIKE :p)").bindparams(
                p=f"ITEST-{RUN_TAG}-%"
            )
        )
        s.execute(
            text("DELETE FROM meal_session_items WHERE meal_session_id IN "
                 "(SELECT id FROM meal_sessions WHERE table_code LIKE :p)").bindparams(
                p=f"ITEST-{RUN_TAG}-%"
            )
        )
        s.execute(
            text("DELETE FROM meal_sessions WHERE table_code LIKE :p").bindparams(
                p=f"ITEST-{RUN_TAG}-%"
            )
        )
        s.execute(
            text("DELETE FROM reward_rules WHERE restaurant_id IN "
                 "(SELECT id FROM restaurants WHERE slug LIKE :p)").bindparams(
                p=f"itest-{RUN_TAG}-%"
            )
        )
        s.execute(
            text("DELETE FROM menu_items WHERE restaurant_id IN "
                 "(SELECT id FROM restaurants WHERE slug LIKE :p)").bindparams(
                p=f"itest-{RUN_TAG}-%"
            )
        )
        s.execute(
            text("DELETE FROM restaurant_staff WHERE user_id IN "
                 "(SELECT id FROM users WHERE email LIKE :p)").bindparams(
                p=f"itest-{RUN_TAG}-%"
            )
        )
        # Also catch dependents on itest-restaurants whose own prefix differs
        # (e.g. test_staff_metrics uses 'staff-metrics-test-' emails and
        # 'TEST-STAFF-METRICS-' table codes).
        itest_slug = f"itest-{RUN_TAG}-%"
        for table, fk in (
            ("staff_validations", "restaurant_id"),
            ("staff_metrics_snapshots", "restaurant_id"),
            ("rewards", "reward_rule_id IN (SELECT id FROM reward_rules WHERE restaurant_id"),
        ):
            if "(" in fk:
                s.execute(
                    text(f"DELETE FROM {table} WHERE {fk} IN "
                         "(SELECT id FROM restaurants WHERE slug LIKE :p))").bindparams(
                        p=itest_slug
                    )
                )
            else:
                s.execute(
                    text(f"DELETE FROM {table} WHERE {fk} IN "
                         "(SELECT id FROM restaurants WHERE slug LIKE :p)").bindparams(
                        p=itest_slug
                    )
                )
        # Wipe meal-session children + meal_sessions for itest-restaurants.
        for table in (
            "consumption_scores",
            "plate_captures",
            "meal_session_items",
            "disputes",
            "fraud_signals",
        ):
            s.execute(
                text(f"DELETE FROM {table} WHERE meal_session_id IN "
                     "(SELECT id FROM meal_sessions WHERE restaurant_id IN "
                     "(SELECT id FROM restaurants WHERE slug LIKE :p))").bindparams(
                    p=itest_slug
                )
            )
        s.execute(
            text("DELETE FROM meal_sessions WHERE restaurant_id IN "
                 "(SELECT id FROM restaurants WHERE slug LIKE :p)").bindparams(
                p=itest_slug
            )
        )
        s.execute(
            text("DELETE FROM reward_rules WHERE restaurant_id IN "
                 "(SELECT id FROM restaurants WHERE slug LIKE :p)").bindparams(
                p=itest_slug
            )
        )
        s.execute(
            text("DELETE FROM menu_items WHERE restaurant_id IN "
                 "(SELECT id FROM restaurants WHERE slug LIKE :p)").bindparams(
                p=itest_slug
            )
        )
        s.execute(
            text("DELETE FROM restaurant_staff WHERE restaurant_id IN "
                 "(SELECT id FROM restaurants WHERE slug LIKE :p)").bindparams(
                p=itest_slug
            )
        )
        # QR tokens FK restaurants — wipe test-created ones by
        # batch_label prefix so restaurant deletion doesn't cascade
        # NULL them (which would then leak into other runs).
        s.execute(
            text(
                "DELETE FROM qr_tokens WHERE batch_label LIKE :p "
                "OR restaurant_id IN "
                "(SELECT id FROM restaurants WHERE slug LIKE :p2)"
            ).bindparams(p=f"itest-{RUN_TAG}-%", p2=f"itest-{RUN_TAG}-%")
        )
        # Bug reports FK users + restaurants — wipe test-owned rows
        # before the users / restaurants delete lines below or the FK
        # constraint fires. Match either FK to be thorough.
        s.execute(
            text(
                "DELETE FROM bug_reports WHERE reported_by_user_id IN "
                "(SELECT id FROM users WHERE email LIKE :p)"
            ).bindparams(p=f"itest-{RUN_TAG}-%")
        )
        s.execute(
            text(
                "DELETE FROM bug_reports WHERE restaurant_id IN "
                "(SELECT id FROM restaurants WHERE slug LIKE :p)"
            ).bindparams(p=f"itest-{RUN_TAG}-%")
        )
        s.execute(
            text("DELETE FROM restaurants WHERE slug LIKE :p").bindparams(
                p=f"itest-{RUN_TAG}-%"
            )
        )
        s.execute(
            text("DELETE FROM users WHERE email LIKE :p").bindparams(
                p=f"itest-{RUN_TAG}-%"
            )
        )
        s.commit()


@pytest.fixture(autouse=True)
def reset_redis_rate_limits() -> Iterator[None]:
    """Tests share a redis with the dev API. Wipe our per-user counters."""
    import redis as _redis_sync

    from app.config import get_settings

    yield
    r = _redis_sync.Redis.from_url(get_settings().REDIS_URL, decode_responses=True)
    for pattern in ("rl:*", "nonce:*", "otp:*"):
        keys = list(r.scan_iter(match=pattern))
        if keys:
            r.delete(*keys)


@pytest.fixture
def fake_s3(monkeypatch) -> dict[str, bytes]:
    """Monkey-patch app.services.storage so capture endpoints don't need MinIO."""
    from app.services import storage as storage_module

    bucket: dict[str, bytes] = {}

    def _upload(session_id, phase, image_bytes, mime):
        key = f"captures/{session_id}/{phase}.{'jpg' if mime == 'image/jpeg' else 'png'}"
        bucket[key] = image_bytes
        return key

    def _signed_url(key, expires_seconds=900):
        return f"https://fake-s3.test/{key}?exp={expires_seconds}"

    def _download(key):
        return bucket[key]

    def _delete(key):
        bucket.pop(key, None)

    def _ensure():
        return None

    monkeypatch.setattr(storage_module, "upload_capture", _upload)
    monkeypatch.setattr(storage_module, "signed_url", _signed_url)
    monkeypatch.setattr(storage_module, "download", _download)
    monkeypatch.setattr(storage_module, "delete", _delete)
    monkeypatch.setattr(storage_module, "ensure_bucket", _ensure)
    return bucket


@pytest.fixture
def fake_scoring(monkeypatch) -> dict[str, object]:
    """Patch the Celery task so capture-after writes a synthetic score
    inline and transitions the session, instead of hitting Anthropic and
    Celery."""
    from datetime import datetime as _dt

    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session as _S

    from app.config import get_settings
    from app.models.consumption_score import ConsumptionScore
    from app.models.meal_session import MealSession

    config = {"overall": 0.85, "confidence": 0.92, "suspicious": False}

    class _FakeAsyncResult:
        def __init__(self, sid):
            self.id = sid

    def fake_delay(session_id_str: str):
        engine = create_engine(get_settings().DATABASE_URL_SYNC, future=True)
        with _S(engine, future=True) as s:
            session = s.get(MealSession, uuid.UUID(session_id_str))
            if session is None:
                return _FakeAsyncResult(session_id_str)
            s.add(
                ConsumptionScore(
                    meal_session_id=session.id,
                    overall_score=Decimal(str(config["overall"])),
                    per_item_scores=[
                        {"dish_name": "Test Dish", "consumption": float(config["overall"]), "confidence": 0.9}
                    ],
                    model_name="test-stub",
                    model_version="stub-1",
                    processing_ms=42,
                    suspicious=bool(config["suspicious"]),
                    confidence=Decimal(str(config["confidence"])),
                    notes="stubbed scoring for tests",
                )
            )
            session.status = "pending_staff_validation"
            session.updated_at = _dt.now(UTC)
            s.commit()
        return _FakeAsyncResult(session_id_str)

    from app.tasks import scoring as scoring_module

    monkeypatch.setattr(scoring_module.score_meal_session, "delay", fake_delay)
    return config


@pytest_asyncio.fixture
async def client() -> AsyncIterator:
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


# -- factories --------------------------------------------------------------


def png_bytes(size: int = 64, color: tuple[int, int, int] = (180, 90, 60)) -> bytes:
    """A solid-color PNG with one unique pixel per call.

    The unique pixel keeps each call's sha256 distinct so the duplicate-hash
    fraud check (signal #5) doesn't collide between repeat test runs against
    a shared dev database.
    """
    from PIL import ImageDraw

    img = Image.new("RGB", (size, size), color)
    draw = ImageDraw.Draw(img)
    # Random pixel in a corner, unique per call.
    rx = uuid.uuid4().int % 256
    gx = (uuid.uuid4().int >> 8) % 256
    bx = (uuid.uuid4().int >> 16) % 256
    draw.point((0, 0), fill=(rx, gx, bx))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


async def register_diner(
    client_,
    *,
    label: str = "diner",
    password: str = "plate-clean-demo",
    phone: str | None = None,
):
    """Async helper: call /auth/register and return (user_dict, token).

    Phone is now required at signup (dual-channel sprint). Callers can
    override it — most tests don't care and let the helper mint a
    unique-per-run number."""
    email = make_email(label)
    res = await client_.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "phone": phone or make_phone(),
            "password": password,
            "display_name": f"Test {label}",
            "is_adult": True,
        },
    )
    assert res.status_code in (200, 201), res.text
    body = res.json()
    return body["user"], body["token"]


def make_restaurant(db: Session, *, name: str = "Test Spot", lat: float = 19.06, lng: float = 72.83):
    from app.models.menu_item import MenuItem
    from app.models.restaurant import Restaurant
    from app.models.reward import RewardRule

    restaurant = Restaurant(
        name=name,
        slug=make_slug(name.lower().replace(" ", "-")),
        address=f"Test address for {name}",
        latitude=lat,
        longitude=lng,
        geofence_radius_m=100,
        timezone="Asia/Kolkata",
        currency="INR",
        is_active=True,
    )
    db.add(restaurant)
    db.flush()
    items = []
    main = MenuItem(
        restaurant_id=restaurant.id,
        name="Test Main",
        price_minor=30000,
        category="main",
        is_reward_eligible=False,
        is_active=True,
    )
    dessert = MenuItem(
        restaurant_id=restaurant.id,
        name="Test Dessert",
        price_minor=10000,
        category="dessert",
        is_reward_eligible=True,
        is_active=True,
    )
    db.add(main)
    db.add(dessert)
    db.flush()
    items.append(main)
    items.append(dessert)
    rule = RewardRule(
        restaurant_id=restaurant.id,
        name=f"Free {dessert.name}",
        consumption_threshold=Decimal("0.75"),
        reward_menu_item_id=dessert.id,
        daily_redemption_cap_per_user=1,
        is_active=True,
    )
    db.add(rule)
    db.commit()
    return restaurant, items, rule


def make_staff(db: Session, restaurant_id, *, password: str = "plate-clean-demo"):
    from app.models.restaurant import RestaurantStaff
    from app.models.user import User
    from app.security import hash_password

    user = User(
        email=make_email("staff"),
        display_name="Test Staff",
        role="staff",
        password_hash=hash_password(password),
    )
    db.add(user)
    db.flush()
    db.add(RestaurantStaff(user_id=user.id, restaurant_id=restaurant_id, role="manager"))
    db.commit()
    return user


async def login(client_, email: str, password: str = "plate-clean-demo") -> str:
    res = await client_.post(
        "/api/v1/auth/login", json={"email": email, "password": password}
    )
    assert res.status_code == 200, res.text
    return res.json()["token"]
