"""Integration tests for the image-retention purge job + the
PATCH /auth/me retention opt-in.

CLAUDE.md ethics rule 6: default 7 days, per-user opt-in up to 90.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.meal_session import MealSession
from app.models.plate_capture import PlateCapture
from app.models.user import User
from app.tasks.image_retention import _scan
from tests.conftest import (
    make_restaurant,
    make_table_code,
    register_diner,
)

settings = get_settings()


@pytest.fixture
def sync_db() -> Session:
    engine = create_engine(settings.DATABASE_URL_SYNC, future=True)
    with Session(engine, future=True) as session:
        yield session


def _make_capture(
    sync_db: Session,
    diner_id,
    restaurant_id,
    *,
    captured_at: datetime,
    phase: str = "before",
) -> PlateCapture:
    """Create a meal_session + plate_capture row at a controlled captured_at."""
    session = MealSession(
        diner_user_id=diner_id,
        restaurant_id=restaurant_id,
        table_code=make_table_code("retain"),
        status="rewarded",
        started_at=captured_at,
        expires_at=captured_at + timedelta(hours=4),
    )
    sync_db.add(session)
    sync_db.flush()
    capture = PlateCapture(
        meal_session_id=session.id,
        phase=phase,
        image_s3_key=f"captures/{session.id}/{phase}.jpg",
        image_sha256=f"deadbeef-{captured_at.timestamp()}-{phase}",
        captured_at=captured_at,
        nonce="test-nonce",
    )
    sync_db.add(capture)
    sync_db.flush()
    return capture


@pytest.mark.asyncio
async def test_purge_removes_captures_older_than_retention(
    client, db, sync_db, monkeypatch
):
    deleted_keys: list[str] = []

    def fake_delete(key: str) -> None:
        deleted_keys.append(key)

    monkeypatch.setattr("app.services.storage.delete", fake_delete)
    monkeypatch.setattr("app.tasks.image_retention.storage.delete", fake_delete)

    restaurant, _, _ = make_restaurant(sync_db, name="Retain Old")
    _, _ = await register_diner(client, label="oldcap")
    # We have to look the diner up again — register_diner went through the
    # async API; sync_db here doesn't share its session state.
    from sqlalchemy import select

    user = sync_db.execute(
        select(User).where(User.email.like("itest-%"))
        .order_by(User.created_at.desc())
        .limit(1)
    ).scalar_one()

    now = datetime.now(UTC)
    old = _make_capture(
        sync_db, user.id, restaurant.id, captured_at=now - timedelta(days=8)
    )
    fresh = _make_capture(
        sync_db, user.id, restaurant.id, captured_at=now - timedelta(days=2)
    )
    sync_db.commit()

    purged = _scan(sync_db, now)
    sync_db.commit()

    assert purged == 1
    sync_db.refresh(old)
    sync_db.refresh(fresh)
    assert old.image_s3_key is None
    assert fresh.image_s3_key is not None
    assert deleted_keys == [f"captures/{old.meal_session_id}/before.jpg"]


@pytest.mark.asyncio
async def test_opt_in_to_90_days_defers_purge(client, db, sync_db, monkeypatch):
    monkeypatch.setattr("app.services.storage.delete", lambda _: None)
    monkeypatch.setattr("app.tasks.image_retention.storage.delete", lambda _: None)

    restaurant, _, _ = make_restaurant(sync_db, name="Retain Opt-in")
    user_payload, token = await register_diner(client, label="optin")
    # Diner opts in to 90 days.
    res = await client.patch(
        "/api/v1/auth/me",
        json={"image_retention_days": 90},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["image_retention_days"] == 90

    from sqlalchemy import select

    user = sync_db.execute(
        select(User).where(User.id == user_payload["id"])
    ).scalar_one()

    now = datetime.now(UTC)
    # 20 days old — would be purged under the 7-day default, kept under 90.
    cap = _make_capture(
        sync_db, user.id, restaurant.id, captured_at=now - timedelta(days=20)
    )
    sync_db.commit()

    purged = _scan(sync_db, now)
    sync_db.commit()
    assert purged == 0
    sync_db.refresh(cap)
    assert cap.image_s3_key is not None


@pytest.mark.asyncio
async def test_patch_me_rejects_out_of_range(client):
    _, token = await register_diner(client, label="badret")
    too_short = await client.patch(
        "/api/v1/auth/me",
        json={"image_retention_days": 1},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert too_short.status_code == 422
    too_long = await client.patch(
        "/api/v1/auth/me",
        json={"image_retention_days": 365},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert too_long.status_code == 422


@pytest.mark.asyncio
async def test_patch_me_updates_display_name(client):
    user, token = await register_diner(client, label="rename")
    res = await client.patch(
        "/api/v1/auth/me",
        json={"display_name": "New Name"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["display_name"] == "New Name"
    assert body["id"] == user["id"]


@pytest.mark.asyncio
async def test_purge_is_idempotent(client, db, sync_db, monkeypatch):
    deleted_keys: list[str] = []
    monkeypatch.setattr(
        "app.tasks.image_retention.storage.delete", lambda k: deleted_keys.append(k)
    )

    restaurant, _, _ = make_restaurant(sync_db, name="Retain Idem")
    _, token = await register_diner(client, label="idem")
    from sqlalchemy import select

    user = sync_db.execute(
        select(User).where(User.email.like("itest-%"))
        .order_by(User.created_at.desc())
        .limit(1)
    ).scalar_one()

    now = datetime.now(UTC)
    _make_capture(sync_db, user.id, restaurant.id, captured_at=now - timedelta(days=10))
    sync_db.commit()

    first = _scan(sync_db, now)
    sync_db.commit()
    second = _scan(sync_db, now)
    sync_db.commit()
    # First run deletes; second sees image_s3_key=NULL and skips.
    assert first == 1
    assert second == 0
    assert len(deleted_keys) == 1
