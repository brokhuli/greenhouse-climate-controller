"""The Phase-2 client validates reads and maps every write response to a canonical outcome."""

from __future__ import annotations

import httpx
import pytest
import respx

from climate_optimizer.config import Settings
from climate_optimizer.dataaccess import PlatformClient, PlatformError
from climate_optimizer.models import ReasonCode, SetpointsPatch
from conftest import build_setpoints, load_fixture

_READ_URL = "http://api:8080/api/greenhouses/gh-a/planning-context"
_WRITE_URL = "http://api:8080/api/greenhouses/gh-a/setpoints"
_PATCH = SetpointsPatch(temperature_day_c=22.5)


@respx.mock
async def test_read_ok() -> None:
    payload = load_fixture("platform-optimizer-planning-rest/examples/planning-context.json")
    respx.get(_READ_URL).mock(return_value=httpx.Response(200, json=payload))
    async with PlatformClient(Settings()) as client:
        ctx = await client.get_planning_context("gh-a")
    assert ctx.greenhouse_id == "gh-a"


@respx.mock
async def test_read_404_is_contract_drift() -> None:
    respx.get(_READ_URL).mock(
        return_value=httpx.Response(404, json={"error": "no such greenhouse"})
    )
    async with PlatformClient(Settings()) as client:
        with pytest.raises(PlatformError) as err:
            await client.get_planning_context("gh-a")
    assert err.value.reason_code is ReasonCode.CONTRACT_DRIFT


@respx.mock
async def test_read_transport_failure_is_platform_unavailable() -> None:
    respx.get(_READ_URL).mock(side_effect=httpx.ConnectError("refused"))
    async with PlatformClient(Settings()) as client:
        with pytest.raises(PlatformError) as err:
            await client.get_planning_context("gh-a")
    assert err.value.reason_code is ReasonCode.PLATFORM_UNAVAILABLE


@respx.mock
async def test_write_202_applied() -> None:
    body = build_setpoints().model_dump(mode="json")
    respx.post(_WRITE_URL).mock(return_value=httpx.Response(202, json=body))
    async with PlatformClient(Settings()) as client:
        outcome = await client.submit_setpoints("gh-a", _PATCH)
    assert outcome.applied
    assert outcome.setpoints is not None
    assert not outcome.controller_offline


@respx.mock
async def test_write_503_applied_controller_offline() -> None:
    respx.post(_WRITE_URL).mock(
        return_value=httpx.Response(503, json={"error": "controller offline"})
    )
    async with PlatformClient(Settings()) as client:
        outcome = await client.submit_setpoints("gh-a", _PATCH)
    assert outcome.applied
    assert outcome.controller_offline


@pytest.mark.parametrize(
    ("status", "reason"),
    [
        (422, ReasonCode.BOUNDS_MISMATCH),
        (401, ReasonCode.WRITE_UNAUTHORIZED),
        (403, ReasonCode.WRITE_UNAUTHORIZED),
        (404, ReasonCode.CONTRACT_DRIFT),
        (500, ReasonCode.PLATFORM_UNAVAILABLE),
    ],
)
@respx.mock
async def test_write_error_mapping(status: int, reason: ReasonCode) -> None:
    respx.post(_WRITE_URL).mock(return_value=httpx.Response(status, json={"error": "x"}))
    async with PlatformClient(Settings()) as client:
        outcome = await client.submit_setpoints("gh-a", _PATCH)
    assert not outcome.applied
    assert outcome.reason_code is reason


@respx.mock
async def test_write_transport_failure_is_platform_unavailable() -> None:
    respx.post(_WRITE_URL).mock(side_effect=httpx.ConnectError("refused"))
    async with PlatformClient(Settings()) as client:
        outcome = await client.submit_setpoints("gh-a", _PATCH)
    assert outcome.reason_code is ReasonCode.PLATFORM_UNAVAILABLE


@respx.mock
async def test_oidc_mode_attaches_bearer_token() -> None:
    route = respx.post(_WRITE_URL).mock(
        return_value=httpx.Response(202, json=build_setpoints().model_dump(mode="json"))
    )
    settings = Settings(platform_auth={"mode": "oidc"})
    async with PlatformClient(settings, bearer_token="tok-123") as client:
        await client.submit_setpoints("gh-a", _PATCH)
    assert route.calls.last.request.headers["authorization"] == "Bearer tok-123"


@respx.mock
async def test_trusted_network_sends_no_token() -> None:
    route = respx.post(_WRITE_URL).mock(
        return_value=httpx.Response(202, json=build_setpoints().model_dump(mode="json"))
    )
    async with PlatformClient(Settings(), bearer_token="tok-123") as client:
        await client.submit_setpoints("gh-a", _PATCH)
    assert "authorization" not in route.calls.last.request.headers
