"""Tests for the msg91 SMS client.

Two things we care about:

1. The request we POST to msg91 is DLT-shaped correctly — right URL,
   right authkey header, right template_id, right variable slots.
2. Failure modes (missing config, HTTP error, non-success body) all
   return `sent=False` with an actionable `.error` string. They must
   never raise — the caller can't roll back a reward just because
   msg91 blipped.

We mock `httpx.Client` via a pytest monkeypatch. Nothing in this test
touches the real network.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from app.services import msg91 as msg91_mod


class _FakeResponse:
    def __init__(self, status_code: int, body: dict[str, Any] | str):
        self.status_code = status_code
        if isinstance(body, dict):
            self._json = body
            self.text = str(body)
        else:
            self._json = None
            self.text = body

    def json(self) -> dict[str, Any]:
        if self._json is None:
            raise ValueError("not json")
        return self._json


class _FakeClient:
    """Captures the last request made so tests can assert on it."""

    def __init__(self, response: _FakeResponse | Exception):
        self._response = response
        self.calls: list[dict[str, Any]] = []

    def __enter__(self) -> "_FakeClient":
        return self

    def __exit__(self, *_a: Any) -> None:
        return None

    def post(
        self, url: str, *, headers: dict[str, str], json: dict[str, Any]
    ) -> _FakeResponse:
        self.calls.append({"url": url, "headers": headers, "json": json})
        if isinstance(self._response, Exception):
            raise self._response
        return self._response


def _configure(monkeypatch: pytest.MonkeyPatch, **overrides: str) -> None:
    """Bypass the pydantic settings cache and stub what msg91 needs."""
    defaults = {
        "MSG91_AUTH_KEY": "test-auth-key",
        "MSG91_SENDER_ID": "PLTCLN",
        "MSG91_BASE_URL": "https://control.msg91.com",
        "MSG91_OTP_TEMPLATE_ID": "otp-tid",
        "MSG91_RESET_TEMPLATE_ID": "",
        "MSG91_REWARD_TEMPLATE_ID": "reward-tid",
        "MSG91_BILL_TEMPLATE_ID": "bill-tid",
        "MSG91_TIMEOUT_SECONDS": 8,
    }
    defaults.update(overrides)

    def _fake_get_settings() -> Any:
        return SimpleNamespace(**defaults)

    monkeypatch.setattr(msg91_mod, "get_settings", _fake_get_settings)


def _install_fake_http(
    monkeypatch: pytest.MonkeyPatch, response: _FakeResponse | Exception
) -> _FakeClient:
    fake = _FakeClient(response)
    monkeypatch.setattr(msg91_mod.httpx, "Client", lambda **_kw: fake)
    return fake


# ── normalize_phone_for_msg91 ───────────────────────────────────────


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("+91 98765 43210", "919876543210"),
        ("+919876543210", "919876543210"),
        ("91 98765 43210", "919876543210"),
        ("9876543210", "919876543210"),  # bare 10-digit assumed India
        ("+1 415 555 0100", "14155550100"),
    ],
)
def test_normalize_phone_for_msg91_handles_common_shapes(
    raw: str, expected: str
) -> None:
    assert msg91_mod.normalize_phone_for_msg91(raw) == expected


# ── happy path per helper ───────────────────────────────────────────


def test_send_otp_posts_correct_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)
    fake = _install_fake_http(
        monkeypatch, _FakeResponse(200, {"type": "success", "message": "req-1"})
    )

    result = msg91_mod.send_otp("+91 98765 43210", "123456")

    assert result.sent is True
    assert result.provider_message_id == "req-1"
    assert len(fake.calls) == 1
    call = fake.calls[0]
    assert call["url"] == "https://control.msg91.com/api/v5/flow/"
    assert call["headers"]["authkey"] == "test-auth-key"
    assert call["json"]["template_id"] == "otp-tid"
    assert call["json"]["short_url"] == "0"
    assert call["json"]["sender"] == "PLTCLN"
    recipient = call["json"]["recipients"][0]
    assert recipient["mobiles"] == "919876543210"
    assert recipient["var1"] == "123456"


def test_send_reset_otp_falls_back_to_otp_template(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No dedicated reset template → we reuse the OTP one so the
    operator can ship prod SMS without configuring a second flow."""
    _configure(monkeypatch, MSG91_RESET_TEMPLATE_ID="")
    fake = _install_fake_http(
        monkeypatch, _FakeResponse(200, {"type": "success", "message": "req-2"})
    )

    result = msg91_mod.send_reset_otp("+919876543210", "654321")

    assert result.sent is True
    assert fake.calls[0]["json"]["template_id"] == "otp-tid"


def test_send_reset_otp_uses_dedicated_template_when_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch, MSG91_RESET_TEMPLATE_ID="reset-tid")
    fake = _install_fake_http(
        monkeypatch, _FakeResponse(200, {"type": "success", "message": "req-3"})
    )

    msg91_mod.send_reset_otp("+919876543210", "111222")

    assert fake.calls[0]["json"]["template_id"] == "reset-tid"


def test_send_reward_passes_restaurant_and_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)
    fake = _install_fake_http(
        monkeypatch, _FakeResponse(200, {"type": "success", "message": "req-4"})
    )

    result = msg91_mod.send_reward(
        "9876543210", code="PLATE-4E43", restaurant_name="Spice Trail"
    )

    assert result.sent is True
    recipient = fake.calls[0]["json"]["recipients"][0]
    assert recipient["var1"] == "Spice Trail"
    assert recipient["var2"] == "PLATE-4E43"


def test_send_bill_passes_number_and_total(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)
    fake = _install_fake_http(
        monkeypatch, _FakeResponse(200, {"type": "success", "message": "req-5"})
    )

    msg91_mod.send_bill(
        "+91 98765 43210",
        restaurant_name="Spice Trail",
        bill_number="SPT/2026/0007",
        total="₹724.50",
    )

    recipient = fake.calls[0]["json"]["recipients"][0]
    assert recipient["var1"] == "Spice Trail"
    assert recipient["var2"] == "SPT/2026/0007"
    assert recipient["var3"] == "₹724.50"


# ── failure modes ───────────────────────────────────────────────────


def test_missing_auth_key_returns_error_without_calling_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Absence of MSG91_AUTH_KEY is a common misconfiguration on a
    fresh staging deploy. We should surface it as a clear error, not
    a stack trace, and NOT hit the network."""
    _configure(monkeypatch, MSG91_AUTH_KEY="")

    called = {"n": 0}

    def _boom(**_kw: Any) -> Any:
        called["n"] += 1
        raise AssertionError("must not be called when auth key missing")

    monkeypatch.setattr(msg91_mod.httpx, "Client", _boom)

    result = msg91_mod.send_otp("9876543210", "123456")

    assert result.sent is False
    assert result.error == "MSG91_AUTH_KEY not configured"
    assert called["n"] == 0


def test_missing_template_id_returns_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch, MSG91_REWARD_TEMPLATE_ID="")
    fake = _install_fake_http(
        monkeypatch, _FakeResponse(200, {"type": "success"})
    )

    result = msg91_mod.send_reward(
        "9876543210", code="PLATE-1", restaurant_name="X"
    )

    assert result.sent is False
    assert result.error == "template_id missing"
    assert fake.calls == []


def test_gateway_error_body_captured_in_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)
    _install_fake_http(
        monkeypatch,
        _FakeResponse(200, {"type": "error", "message": "Invalid template"}),
    )

    result = msg91_mod.send_otp("9876543210", "123456")

    assert result.sent is False
    assert result.error == "Invalid template"


def test_http_500_returns_status_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)
    _install_fake_http(monkeypatch, _FakeResponse(503, "gateway down"))

    result = msg91_mod.send_otp("9876543210", "123456")

    assert result.sent is False
    assert result.error == "status_503"


def test_http_transport_error_is_caught(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Network blip must not crash — the caller has already committed
    an OTP entry or a reward row to Postgres."""
    import httpx  # noqa: PLC0415

    _configure(monkeypatch)
    _install_fake_http(monkeypatch, httpx.ConnectError("dns fail"))

    result = msg91_mod.send_otp("9876543210", "123456")

    assert result.sent is False
    assert result.error is not None
    assert result.error.startswith("http_error:")
