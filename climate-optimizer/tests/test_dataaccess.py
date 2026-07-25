"""The Phase-2 client validates reads and maps every write response to a canonical outcome."""

from __future__ import annotations

from uuid import UUID

import httpx
import pytest
import respx

from climate_optimizer.config import Settings
from climate_optimizer.infra.dataaccess import PlatformClient, PlatformError
from climate_optimizer.models import ReasonCode, SetpointsPatch
from conftest import build_setpoints, load_fixture

_READ_URL = "http://api:8080/api/greenhouses/gh-a/planning-context"
_WRITE_URL = "http://api:8080/api/greenhouses/gh-a/setpoints"
_PATCH = SetpointsPatch(temperature_day_c=22.5)
_RUN_ID = UUID("018f9c2e-6b7a-7c31-9e4d-2a1b5c6d7e8f")


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
        outcome = await client.submit_setpoints("gh-a", _PATCH, optimizer_run_id=_RUN_ID)
    assert outcome.applied
    assert outcome.setpoints is not None


@respx.mock
async def test_write_sends_optimizer_run_id_header() -> None:
    # P3-OBS-1: the applied bundle must carry its run id so Phase 2 can record it as provenance.
    route = respx.post(_WRITE_URL).mock(
        return_value=httpx.Response(202, json=build_setpoints().model_dump(mode="json"))
    )
    async with PlatformClient(Settings()) as client:
        await client.submit_setpoints("gh-a", _PATCH, optimizer_run_id=_RUN_ID)
    assert route.calls.last.request.headers["x-optimizer-run-id"] == str(_RUN_ID)


@respx.mock
async def test_write_withheld_when_paused_during_token_acquisition() -> None:
    # The commit-point enable check passes, then oidc token acquisition suspends; an operator pauses
    # in that window. still_active is re-checked after the token is in hand and before dispatch, so
    # the write is withheld and never reaches Phase 2 (spec 09 — a disabled optimizer writes nothing).
    route = respx.post(_WRITE_URL).mock(
        return_value=httpx.Response(202, json=build_setpoints().model_dump(mode="json"))
    )
    paused = {"value": False}

    class PausingTokenSource:
        async def token(self) -> str | None:
            paused["value"] = True  # the pause lands while the token request is in flight
            return "service-token"

    settings = Settings(platform_auth={"mode": "oidc", "oidc_token_url": "http://kc/token"})
    async with PlatformClient(settings, token_source=PausingTokenSource()) as client:
        outcome = await client.submit_setpoints(
            "gh-a",
            _PATCH,
            optimizer_run_id=_RUN_ID,
            still_active=lambda: not paused["value"],
        )

    assert outcome.held is True
    assert outcome.applied is False
    assert outcome.reason_code is None
    assert route.called is False  # nothing left the process


@respx.mock
async def test_write_proceeds_when_still_active_holds() -> None:
    # The predicate stays true through token acquisition: the write goes out normally.
    route = respx.post(_WRITE_URL).mock(
        return_value=httpx.Response(202, json=build_setpoints().model_dump(mode="json"))
    )
    async with PlatformClient(Settings()) as client:
        outcome = await client.submit_setpoints(
            "gh-a", _PATCH, optimizer_run_id=_RUN_ID, still_active=lambda: True
        )

    assert outcome.applied is True
    assert route.called is True


@respx.mock
async def test_write_503_escalates_platform_unavailable() -> None:
    # Phase 2's 503 means no baseline could be established and nothing was recorded — the optimizer
    # must not report it as applied (spec 06 Write outcomes).
    respx.post(_WRITE_URL).mock(
        return_value=httpx.Response(503, json={"error": "controller unreachable"})
    )
    async with PlatformClient(Settings()) as client:
        outcome = await client.submit_setpoints("gh-a", _PATCH, optimizer_run_id=_RUN_ID)
    assert not outcome.applied
    assert outcome.reason_code is ReasonCode.PLATFORM_UNAVAILABLE


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
        outcome = await client.submit_setpoints("gh-a", _PATCH, optimizer_run_id=_RUN_ID)
    assert not outcome.applied
    assert outcome.reason_code is reason


@respx.mock
async def test_write_transport_failure_is_platform_unavailable() -> None:
    respx.post(_WRITE_URL).mock(side_effect=httpx.ConnectError("refused"))
    async with PlatformClient(Settings()) as client:
        outcome = await client.submit_setpoints("gh-a", _PATCH, optimizer_run_id=_RUN_ID)
    assert outcome.reason_code is ReasonCode.PLATFORM_UNAVAILABLE


@respx.mock
async def test_oidc_mode_attaches_bearer_token() -> None:
    route = respx.post(_WRITE_URL).mock(
        return_value=httpx.Response(202, json=build_setpoints().model_dump(mode="json"))
    )
    settings = Settings(platform_auth={"mode": "oidc"})
    async with PlatformClient(settings, bearer_token="tok-123") as client:
        await client.submit_setpoints("gh-a", _PATCH, optimizer_run_id=_RUN_ID)
    assert route.calls.last.request.headers["authorization"] == "Bearer tok-123"


@respx.mock
async def test_trusted_network_sends_no_token() -> None:
    route = respx.post(_WRITE_URL).mock(
        return_value=httpx.Response(202, json=build_setpoints().model_dump(mode="json"))
    )
    async with PlatformClient(Settings(), bearer_token="tok-123") as client:
        await client.submit_setpoints("gh-a", _PATCH, optimizer_run_id=_RUN_ID)
    assert "authorization" not in route.calls.last.request.headers
