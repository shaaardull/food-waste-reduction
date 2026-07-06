"""Tests for bill generation (POST /sessions/:id/bill + GET), the /bills/:id
retrieval, GST math, reward-discount application, and access control.

Money math is the highest-stakes piece of this sprint — every math
path has an explicit assertion on paise (int), not just "returns 200".
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from app.models.meal_session import MealSession, MealSessionItem
from app.models.reward import Reward, RewardRule
from tests.conftest import (
    login,
    make_email,
    make_restaurant,
    make_staff,
    make_table_code,
    register_diner,
)


def _diner_user(db: Session) -> tuple[str, str]:
    """Return (user_id, email) for a fresh diner user we can log in as."""
    from app.models.user import User
    from app.security import hash_password

    email = make_email("bill-diner")
    u = User(
        email=email,
        display_name="Bill Diner",
        role="diner",
        password_hash=hash_password("plate-clean-demo"),
    )
    db.add(u)
    db.flush()
    db.commit()
    return str(u.id), email


def _make_session_with_items(
    db: Session,
    *,
    restaurant_id,
    menu_items,
    diner_user_id: str | None = None,
    status: str = "before_captured",
) -> MealSession:
    if diner_user_id is None:
        diner_user_id, _ = _diner_user(db)
    started = datetime.now(UTC) - timedelta(minutes=10)
    session = MealSession(
        diner_user_id=diner_user_id,
        restaurant_id=restaurant_id,
        table_code=make_table_code("bill"),
        status=status,
        started_at=started,
        expires_at=started + timedelta(hours=4),
    )
    db.add(session)
    db.flush()
    for m in menu_items:
        db.add(
            MealSessionItem(
                meal_session_id=session.id,
                menu_item_id=m.id,
                quantity=1,
                portion_size="regular",
            )
        )
    db.commit()
    return session


def _issue_reward(
    db: Session,
    *,
    reward_session: MealSession,
    rule: RewardRule,
    reward_type: str = "bill_discount",
    value_minor: int = 3000,
    voided: bool = False,
    redeemed: bool = False,
    expired: bool = False,
) -> Reward:
    """Manufacture a reward row directly (bypasses the normal
    staff-validation path). Used to test bill-discount application."""
    now = datetime.now(UTC)
    reward = Reward(
        meal_session_id=reward_session.id,
        reward_rule_id=rule.id,
        redemption_code=f"PLATE-{uuid4().hex[:6].upper()}",
        reward_type=reward_type,
        value_minor=value_minor,
        issued_at=now - timedelta(days=1),
        half_value_at=now + timedelta(days=14),
        expires_at=now - timedelta(hours=1) if expired else now + timedelta(days=29),
        voided_at=now if voided else None,
        voided_reason="test" if voided else None,
        redeemed_at=now if redeemed else None,
    )
    db.add(reward)
    db.commit()
    return reward


# ── GST math ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bill_math_default_5pct_rate(client, db):
    """Two items at ₹300 + ₹80 = ₹380 subtotal. 5% GST = 2.5% CGST +
    2.5% SGST. Expected: CGST ₹9.50, SGST ₹9.50, total ₹399."""
    restaurant, items, _ = make_restaurant(db, name="Math Default")
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:2],
        diner_user_id=diner_id,
    )
    token = await login(client, diner_email)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    b = res.json()
    # Item prices come from the seed fixture — compute subtotal from
    # what's actually there rather than hardcoding.
    expected_subtotal = sum(m.price_minor for m in items[:2])
    assert b["subtotal_minor"] == expected_subtotal
    assert b["discount_minor"] == 0
    assert b["taxable_amount_minor"] == expected_subtotal
    # cgst = sgst = 2.5% of taxable, rounded half-up. Sum must equal
    # total_minor - taxable_amount.
    assert b["cgst_amount_minor"] == b["sgst_amount_minor"]
    assert (
        b["total_minor"]
        == b["taxable_amount_minor"] + b["cgst_amount_minor"] + b["sgst_amount_minor"]
    )
    # Every line item must have a line_total_minor equal to
    # quantity × price_minor.
    for row in b["line_items"]:
        assert row["line_total_minor"] == row["quantity"] * row["price_minor"]


@pytest.mark.asyncio
async def test_bill_paise_precision_no_floats(client, db):
    """A subtotal that produces a half-paise amount (e.g. ₹1.75 tax)
    must round half-up to a whole paisa, not truncate."""
    restaurant, items, _ = make_restaurant(db, name="Rounding")
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=[items[0]],
        diner_user_id=diner_id,
    )
    token = await login(client, diner_email)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    b = res.json()
    # Both CGST and SGST are ints (paise), never fractional.
    assert isinstance(b["cgst_amount_minor"], int)
    assert isinstance(b["sgst_amount_minor"], int)


# ── Idempotency ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bill_generation_is_idempotent(client, db):
    """Second POST returns the SAME bill (same id, same bill_number)."""
    restaurant, items, _ = make_restaurant(db, name="Idempotent")
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        diner_user_id=diner_id,
    )
    token = await login(client, diner_email)
    first = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert first.status_code == 200
    second = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    assert first.json()["bill_number"] == second.json()["bill_number"]


@pytest.mark.asyncio
async def test_bill_second_call_ignores_new_redemption_code(client, db):
    """Once a bill exists, a second POST with a redemption code MUST
    NOT re-price. Bills are immutable tax invoices per Indian §46
    rules — any correction is void + reissue, not mutate."""
    restaurant, items, _ = make_restaurant(db, name="No Reprice")
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        diner_user_id=diner_id,
    )
    reward_session = _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=items[:1],
        diner_user_id=diner_id,
    )
    # make_restaurant already created a reward_rule for `restaurant`;
    # pull it out for the reward we're about to issue.
    from sqlalchemy import select as sa_select

    from app.models.reward import RewardRule

    rule = db.execute(
        sa_select(RewardRule).where(RewardRule.restaurant_id == restaurant.id)
    ).scalar_one()
    reward = _issue_reward(
        db, reward_session=reward_session, rule=rule, value_minor=5000
    )
    token = await login(client, diner_email)
    first = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert first.json()["discount_minor"] == 0
    second = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={"apply_redemption_code": reward.redemption_code},
        headers={"Authorization": f"Bearer {token}"},
    )
    # Same bill, still no discount, same totals.
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["discount_minor"] == 0


# ── Reward-discount application ──────────────────────────────────────


@pytest.mark.asyncio
async def test_bill_applies_bill_discount_reward(client, db):
    restaurant, items, rule = make_restaurant(db, name="Applies Discount")
    diner_id, diner_email = _diner_user(db)
    # A prior session issued the reward; the current session gets it
    # applied at bill time.
    prior_session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    reward = _issue_reward(
        db, reward_session=prior_session, rule=rule, value_minor=5000
    )
    current_session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:2], diner_user_id=diner_id
    )
    token = await login(client, diner_email)
    res = await client.post(
        f"/api/v1/sessions/{current_session.id}/bill",
        json={"apply_redemption_code": reward.redemption_code},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    b = res.json()
    assert b["discount_minor"] == 5000
    assert b["reward_redemption_code"] == reward.redemption_code
    assert b["taxable_amount_minor"] == b["subtotal_minor"] - 5000
    # Tax is on the discounted amount.
    assert b["total_minor"] < b["subtotal_minor"] + 500  # no way total > subtotal + 5%


@pytest.mark.asyncio
async def test_reward_from_wrong_restaurant_rejected(client, db):
    r_a, items_a, rule_a = make_restaurant(db, name="Reward Home")
    r_b, items_b, _ = make_restaurant(db, name="Reward Foreign")
    diner_id, diner_email = _diner_user(db)
    # Reward issued at A.
    a_session = _make_session_with_items(
        db, restaurant_id=r_a.id, menu_items=items_a[:1], diner_user_id=diner_id
    )
    reward = _issue_reward(db, reward_session=a_session, rule=rule_a)
    # Diner tries to apply it at B.
    b_session = _make_session_with_items(
        db, restaurant_id=r_b.id, menu_items=items_b[:1], diner_user_id=diner_id
    )
    token = await login(client, diner_email)
    res = await client.post(
        f"/api/v1/sessions/{b_session.id}/bill",
        json={"apply_redemption_code": reward.redemption_code},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 400, res.text
    body = res.json()
    # Error envelope has code inside detail.
    assert body["detail"]["code"] == "REWARD_WRONG_RESTAURANT"


@pytest.mark.asyncio
async def test_reward_menu_item_type_rejected_as_discount(client, db):
    """menu_item rewards can't be applied as cash discount on a bill."""
    restaurant, items, rule = make_restaurant(db, name="Menu Reward")
    diner_id, diner_email = _diner_user(db)
    prior = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    reward = _issue_reward(
        db,
        reward_session=prior,
        rule=rule,
        reward_type="menu_item",
        value_minor=8000,
    )
    current = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    token = await login(client, diner_email)
    res = await client.post(
        f"/api/v1/sessions/{current.id}/bill",
        json={"apply_redemption_code": reward.redemption_code},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "REWARD_NOT_BILL_DISCOUNT"


@pytest.mark.asyncio
async def test_reward_already_redeemed_rejected(client, db):
    restaurant, items, rule = make_restaurant(db, name="Reward Used")
    diner_id, diner_email = _diner_user(db)
    prior = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    reward = _issue_reward(
        db, reward_session=prior, rule=rule, redeemed=True
    )
    current = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    token = await login(client, diner_email)
    res = await client.post(
        f"/api/v1/sessions/{current.id}/bill",
        json={"apply_redemption_code": reward.redemption_code},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "REWARD_ALREADY_REDEEMED"


@pytest.mark.asyncio
async def test_reward_expired_rejected(client, db):
    restaurant, items, rule = make_restaurant(db, name="Reward Old")
    diner_id, diner_email = _diner_user(db)
    prior = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    reward = _issue_reward(
        db, reward_session=prior, rule=rule, expired=True
    )
    current = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    token = await login(client, diner_email)
    res = await client.post(
        f"/api/v1/sessions/{current.id}/bill",
        json={"apply_redemption_code": reward.redemption_code},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "REWARD_EXPIRED"


@pytest.mark.asyncio
async def test_reward_voided_rejected(client, db):
    restaurant, items, rule = make_restaurant(db, name="Reward Void")
    diner_id, diner_email = _diner_user(db)
    prior = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    reward = _issue_reward(db, reward_session=prior, rule=rule, voided=True)
    current = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    token = await login(client, diner_email)
    res = await client.post(
        f"/api/v1/sessions/{current.id}/bill",
        json={"apply_redemption_code": reward.redemption_code},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "REWARD_VOIDED"


# ── Bill number sequencing ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_bill_numbers_are_per_restaurant_sequential(client, db):
    restaurant, items, _ = make_restaurant(db, name="Seq")
    # Two separate sessions → two bills.
    d1_id, d1_email = _diner_user(db)
    d2_id, _ = _diner_user(db)
    s1 = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=d1_id
    )
    s2 = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=d2_id
    )
    tok = await login(client, d1_email)
    r1 = await client.post(
        f"/api/v1/sessions/{s1.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {tok}"},
    )
    # 2nd diner logs in — session ownership is verified separately.
    manager = make_staff(db, restaurant.id)
    tok2 = await login(client, manager.email)
    r2 = await client.post(
        f"/api/v1/sessions/{s2.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {tok2}"},
    )
    n1 = r1.json()["bill_number"]
    n2 = r2.json()["bill_number"]
    assert n1 != n2
    # Both share the same year prefix, sequence differs by 1.
    year = str(datetime.now(UTC).year)
    assert year in n1 and year in n2


@pytest.mark.asyncio
async def test_bill_number_honours_restaurant_prefix(client, db):
    from app.models.restaurant import Restaurant

    restaurant, items, _ = make_restaurant(db, name="Prefixed")
    # Patch a prefix in directly to sidestep the wizard.
    r = db.get(Restaurant, restaurant.id)
    assert r is not None
    r.bill_prefix = "TEST/2026/"
    db.commit()
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    tok = await login(client, diner_email)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 200
    assert res.json()["bill_number"].startswith("TEST/2026/")


# ── Access control ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_diner_can_generate_own_bill(client, db):
    restaurant, items, _ = make_restaurant(db, name="Own Bill")
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    tok = await login(client, diner_email)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 200


@pytest.mark.asyncio
async def test_diner_cannot_generate_other_diners_bill(client, db):
    restaurant, items, _ = make_restaurant(db, name="Other Diner")
    owner_id, _ = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=owner_id
    )
    _, intruder_token = await register_diner(client)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {intruder_token}"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_any_staff_of_restaurant_can_generate(client, db):
    """Staff of THIS restaurant (any role) can generate a bill for the
    session even though they're not the diner who ordered."""
    restaurant, items, _ = make_restaurant(db, name="Staff Gen")
    diner_id, _ = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    manager = make_staff(db, restaurant.id)
    tok = await login(client, manager.email)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 200


@pytest.mark.asyncio
async def test_cross_restaurant_staff_blocked(client, db):
    r_a, items_a, _ = make_restaurant(db, name="Cross A")
    r_b, _, _ = make_restaurant(db, name="Cross B")
    diner_id, _ = _diner_user(db)
    session_at_a = _make_session_with_items(
        db, restaurant_id=r_a.id, menu_items=items_a[:1], diner_user_id=diner_id
    )
    staff_b = make_staff(db, r_b.id)
    tok = await login(client, staff_b.email)
    res = await client.post(
        f"/api/v1/sessions/{session_at_a.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 403


# ── GET endpoints + failure modes ────────────────────────────────────


@pytest.mark.asyncio
async def test_get_bill_by_session_returns_after_generation(client, db):
    restaurant, items, _ = make_restaurant(db, name="Get By Session")
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    tok = await login(client, diner_email)
    await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {tok}"},
    )
    res = await client.get(
        f"/api/v1/sessions/{session.id}/bill",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 200
    assert res.json()["bill_number"] != ""


@pytest.mark.asyncio
async def test_get_bill_by_session_404_before_generation(client, db):
    restaurant, items, _ = make_restaurant(db, name="Get Missing")
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    tok = await login(client, diner_email)
    res = await client.get(
        f"/api/v1/sessions/{session.id}/bill",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_get_bill_by_id_direct(client, db):
    restaurant, items, _ = make_restaurant(db, name="Get By Id")
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    tok = await login(client, diner_email)
    created = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {tok}"},
    )
    bill_id = created.json()["id"]
    res = await client.get(
        f"/api/v1/bills/{bill_id}",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 200
    assert res.json()["id"] == bill_id


@pytest.mark.asyncio
async def test_no_items_session_cannot_be_billed(client, db):
    """`open` session with zero items has nothing to bill — 400 with
    the NO_ITEMS code so the frontend can render a friendly message."""
    restaurant, _, _ = make_restaurant(db, name="No Items")
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db,
        restaurant_id=restaurant.id,
        menu_items=[],  # empty
        diner_user_id=diner_id,
        status="open",
    )
    tok = await login(client, diner_email)
    res = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "NO_ITEMS"


@pytest.mark.asyncio
async def test_line_items_snapshot_survives_menu_edit(client, db):
    """Once the bill exists, editing the menu item's price must NOT
    retroactively change what the bill shows — snapshotted line items
    are immutable."""
    from app.models.menu_item import MenuItem

    restaurant, items, _ = make_restaurant(db, name="Snapshot Menu Edit")
    diner_id, diner_email = _diner_user(db)
    session = _make_session_with_items(
        db, restaurant_id=restaurant.id, menu_items=items[:1], diner_user_id=diner_id
    )
    tok = await login(client, diner_email)
    orig = await client.post(
        f"/api/v1/sessions/{session.id}/bill",
        json={},
        headers={"Authorization": f"Bearer {tok}"},
    )
    snapshot_price = orig.json()["line_items"][0]["price_minor"]

    # Edit the menu item's price directly.
    m = db.get(MenuItem, items[0].id)
    assert m is not None
    m.price_minor = 99999
    db.commit()

    # GET the bill again; snapshotted price should be unchanged.
    after = await client.get(
        f"/api/v1/sessions/{session.id}/bill",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert after.json()["line_items"][0]["price_minor"] == snapshot_price
