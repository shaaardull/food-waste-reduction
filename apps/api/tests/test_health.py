import pytest


@pytest.mark.asyncio
async def test_health(client):
    res = await client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert "version" in body


@pytest.mark.asyncio
async def test_validation_input_requires_final_score_when_adjusted():
    from pydantic import ValidationError

    from app.schemas.validation import ValidationIn

    with pytest.raises(ValidationError):
        ValidationIn(decision="adjusted", reason_code="model_overestimated")


@pytest.mark.asyncio
async def test_validation_input_requires_reason_code_when_rejected():
    from pydantic import ValidationError

    from app.schemas.validation import ValidationIn

    with pytest.raises(ValidationError):
        ValidationIn(decision="rejected")


def test_haversine_self_is_zero():
    from app.security import haversine_m

    assert haversine_m(19.0613, 72.8307, 19.0613, 72.8307) < 0.001


def test_haversine_short_distance():
    from app.security import haversine_m

    # Two points about 100m apart at Mumbai latitudes.
    d = haversine_m(19.0613, 72.8307, 19.0613, 72.8317)
    assert 80 < d < 200


def test_redemption_code_format():
    from app.security import new_redemption_code

    code = new_redemption_code()
    assert code.startswith("PLATE-")
    assert len(code) == len("PLATE-XXXX")
