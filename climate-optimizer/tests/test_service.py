"""The FastAPI Service API — every endpoint in spec 10, plus the operator gate and startup gate."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from langchain_core.runnables import RunnableLambda

from climate_optimizer.config import Settings
from climate_optimizer.models import ReasonCode
from climate_optimizer.params import default_twin_params
from climate_optimizer.planner import Planner, PlannerChain
from climate_optimizer.planner.chain import BackendOutput
from climate_optimizer.runtime import RuntimeState
from climate_optimizer.scheduler import Scheduler
from climate_optimizer.service import (
    ConfigurationError,
    ServiceContext,
    create_app,
    validate_startup,
)
from climate_optimizer.store import Escalation, ServiceStore
from conftest import StubPlatformClient, build_output, chain_factory, fake_chain

NOW = datetime(2026, 6, 17, 12, 0, tzinfo=UTC)


def _context(
    *,
    settings: Settings | None = None,
    client: StubPlatformClient | None = None,
    chain: PlannerChain | None = None,
    runtime: RuntimeState | None = None,
    store: ServiceStore | None = None,
) -> ServiceContext:
    resolved = settings or Settings()
    stub = client or StubPlatformClient(resolved)
    planner = Planner(resolved, chain_factory=chain_factory(chain or fake_chain()))
    state = runtime or RuntimeState(resolved)
    service_store = store or ServiceStore()
    params = default_twin_params()
    return ServiceContext(
        settings=resolved,
        runtime=state,
        store=service_store,
        client=stub,
        planner=planner,
        scheduler=Scheduler(
            settings=resolved,
            client=stub,
            planner=planner,
            runtime=state,
            store=service_store,
            params=params,
        ),
        params=params,
    )


def _client(ctx: ServiceContext | None = None) -> tuple[TestClient, ServiceContext]:
    resolved = ctx or _context()
    app = create_app(context=resolved, start_scheduler=False)
    return TestClient(app), resolved


def _offline_llm_settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    """A cloud provider so the health probe reads the credential instead of dialing Ollama."""
    monkeypatch.setenv("PLANNER_API_KEY", "test-key")
    return Settings(llm={"provider": "anthropic", "available_models": {"anthropic": ["claude-x"]}})


def _raise_escalation(
    store: ServiceStore,
    *,
    reason: ReasonCode = ReasonCode.INPUT_STALE,
    greenhouse: str = "gh-a",
) -> Escalation:
    return store.escalations.raise_escalation(
        greenhouse_id=greenhouse,
        reason_code=reason,
        optimizer_run_id=uuid4(),
        message="held",
        now=NOW,
        dedup_window=timedelta(minutes=60),
    )


# -- health and metrics -----------------------------------------------------


def test_health_reports_cold_start_before_the_first_cycle(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = _offline_llm_settings(monkeypatch)
    settings.llm.model = "claude-x"
    client, _ctx = _client(_context(settings=settings))

    body = client.get("/health").json()

    assert body["status"] == "degraded"
    assert body["degraded_reason"] == "cold_start"
    assert body["enabled"] is True
    assert body["last_successful_cycle_at"] is None
    assert body["cadence_secs"] == 1800


def test_health_is_healthy_after_a_successful_cycle(monkeypatch: pytest.MonkeyPatch) -> None:
    ctx = _context(settings=_offline_llm_settings(monkeypatch))
    ctx.store.last_successful_cycle_at = datetime.now(UTC)
    client, _ctx = _client(ctx)

    body = client.get("/health").json()

    assert body["status"] == "healthy"
    assert body["degraded_reason"] is None


def test_a_paused_optimizer_is_healthy_not_stalled(monkeypatch: pytest.MonkeyPatch) -> None:
    ctx = _context(settings=_offline_llm_settings(monkeypatch))
    ctx.store.last_successful_cycle_at = datetime.now(UTC) - timedelta(days=1)
    ctx.runtime.set_enabled(False, reason="maintenance")
    client, _ctx = _client(ctx)

    body = client.get("/health").json()

    # A paused loop's growing cycle age is expected, not a stall to alert on (spec 09).
    assert body["status"] == "healthy"
    assert body["enabled"] is False
    assert body["read_only_reason"] == "maintenance"


def test_health_reports_a_stalled_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    ctx = _context(settings=_offline_llm_settings(monkeypatch))
    ctx.store.last_successful_cycle_at = datetime.now(UTC) - timedelta(hours=6)
    client, _ctx = _client(ctx)

    assert client.get("/health").json()["degraded_reason"] == "cycle_stalled"


def test_health_reports_an_unreachable_platform(monkeypatch: pytest.MonkeyPatch) -> None:
    from climate_optimizer.dataaccess import PlatformError

    settings = _offline_llm_settings(monkeypatch)
    stub = StubPlatformClient(
        settings, fleet_error=PlatformError(ReasonCode.PLATFORM_UNAVAILABLE, "down")
    )
    client, _ctx = _client(_context(settings=settings, client=stub))

    body = client.get("/health").json()

    assert body["degraded_reason"] == "platform_unreachable"
    assert body["platform_reachable"] is False


def test_health_reports_the_escalation_backlog(monkeypatch: pytest.MonkeyPatch) -> None:
    ctx = _context(settings=_offline_llm_settings(monkeypatch))
    _raise_escalation(ctx.store)
    client, _ctx = _client(ctx)

    assert client.get("/health").json()["escalation_backlog"] == 1


def test_metrics_exposes_the_prometheus_surface() -> None:
    client, _ctx = _client()
    response = client.get("/metrics")

    assert response.status_code == 200
    assert "optimizer_cycles_total" in response.text
    assert "optimizer_open_escalations" in response.text


# -- fleet and plans --------------------------------------------------------


def test_fleet_is_empty_before_any_cycle() -> None:
    client, _ctx = _client()
    body = client.get("/api/optimizer/fleet").json()

    assert body["greenhouses"] == []
    assert body["rollup"]["backlog"] == 0


def test_fleet_reports_each_greenhouse_and_the_rollup() -> None:
    client, ctx = _client()
    client.post("/api/optimizer/greenhouses/gh-a/cycles", json={})
    _raise_escalation(ctx.store, greenhouse="gh-b")

    body = client.get("/api/optimizer/fleet").json()

    assert [g["greenhouse_id"] for g in body["greenhouses"]] == ["gh-a"]
    assert body["greenhouses"][0]["status"] == "applied"
    assert body["greenhouses"][0]["enabled"] is True
    assert body["rollup"] == {
        "backlog": 1,
        "applied": 1,
        "escalated": 0,
        "extended": 0,
        "oldest_open_escalation_age_seconds": pytest.approx(
            body["rollup"]["oldest_open_escalation_age_seconds"]
        ),
    }


def test_fleet_shows_a_paused_greenhouse_as_disabled() -> None:
    client, ctx = _client()
    client.post("/api/optimizer/greenhouses/gh-a/cycles", json={})
    ctx.runtime.set_greenhouse_enabled("gh-a", False)

    body = client.get("/api/optimizer/fleet").json()
    assert body["greenhouses"][0]["enabled"] is False


def test_latest_plan_is_404_before_any_cycle() -> None:
    client, _ctx = _client()
    assert client.get("/api/optimizer/greenhouses/gh-a/plans/latest").status_code == 404


def test_latest_plan_returns_the_recorded_envelope() -> None:
    client, _ctx = _client()
    client.post("/api/optimizer/greenhouses/gh-a/cycles", json={})

    body = client.get("/api/optimizer/greenhouses/gh-a/plans/latest").json()

    assert body["greenhouse_id"] == "gh-a"
    assert body["outcome"]["status"] == "applied"
    assert body["backend"]["prompt_version"] == "v1"
    assert body["plan"]["confidence"] == 0.95


# -- on-demand cycles -------------------------------------------------------


def test_triggering_a_cycle_returns_202_and_the_record() -> None:
    client, _ctx = _client()
    response = client.post(
        "/api/optimizer/greenhouses/gh-a/cycles", json={"reason": "operator check"}
    )

    assert response.status_code == 202
    assert response.json()["outcome"]["status"] == "applied"


def test_triggering_while_globally_paused_is_409() -> None:
    client, ctx = _client()
    ctx.runtime.set_enabled(False)

    assert client.post("/api/optimizer/greenhouses/gh-a/cycles", json={}).status_code == 409


def test_triggering_a_paused_greenhouse_is_409() -> None:
    client, ctx = _client()
    ctx.runtime.set_greenhouse_enabled("gh-a", False)

    assert client.post("/api/optimizer/greenhouses/gh-a/cycles", json={}).status_code == 409


async def test_triggering_a_greenhouse_already_planning_is_409() -> None:
    release = asyncio.Event()

    async def gated(_payload: dict[str, Any]) -> BackendOutput:
        await release.wait()
        return build_output()

    gated_chain: PlannerChain = RunnableLambda(gated)
    ctx = _context(chain=gated_chain)
    app = create_app(context=ctx, start_scheduler=False)
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        first = asyncio.create_task(client.post("/api/optimizer/greenhouses/gh-a/cycles", json={}))
        while not ctx.scheduler.is_in_flight("gh-a"):
            await asyncio.sleep(0.01)

        second = await client.post("/api/optimizer/greenhouses/gh-a/cycles", json={})
        release.set()
        await first

    assert second.status_code == 409


# -- escalations ------------------------------------------------------------


def test_escalations_start_empty() -> None:
    client, _ctx = _client()
    assert client.get("/api/optimizer/escalations").json() == []


def test_escalations_are_listed_persistent_first() -> None:
    client, ctx = _client()
    _raise_escalation(ctx.store, reason=ReasonCode.INPUT_STALE)
    _raise_escalation(ctx.store, reason=ReasonCode.CONTRACT_DRIFT)

    body = client.get("/api/optimizer/escalations").json()

    assert [item["reason_code"] for item in body] == ["contract_drift", "input_stale"]
    assert body[0]["reason_class"] == "persistent"


def test_resolving_an_escalation_closes_it() -> None:
    client, ctx = _client()
    escalation = _raise_escalation(ctx.store)

    response = client.post(
        f"/api/optimizer/escalations/{escalation.escalation_id}/resolve",
        json={"reason": "sensor replaced"},
    )

    assert response.status_code == 200
    assert response.json()["resolution"] == "operator"
    assert client.get("/api/optimizer/escalations").json() == []


def test_resolving_an_unknown_escalation_is_404() -> None:
    client, _ctx = _client()
    assert client.post(f"/api/optimizer/escalations/{uuid4()}/resolve", json={}).status_code == 404


# -- model selection --------------------------------------------------------


def test_model_reports_the_active_backend_and_allowlist() -> None:
    client, _ctx = _client()
    body = client.get("/api/optimizer/model").json()

    assert body["provider"] == "ollama"
    assert body["model"] == "qwen2.5:7b"
    assert body["prompt_version"] == "v1"
    assert "mistral" in body["available_models"]


def test_switching_to_an_allowlisted_model() -> None:
    client, ctx = _client()
    response = client.post("/api/optimizer/model", json={"model": "mistral", "reason": "A/B"})

    assert response.status_code == 200
    assert response.json()["model"] == "mistral"
    assert ctx.runtime.model == "mistral"


def test_switching_to_an_unvetted_model_is_400() -> None:
    client, ctx = _client()
    response = client.post("/api/optimizer/model", json={"model": "not-vetted"})

    assert response.status_code == 400
    assert ctx.runtime.model == "qwen2.5:7b"


# -- enable / disable -------------------------------------------------------


def test_enabled_defaults_to_on() -> None:
    client, _ctx = _client()
    assert client.get("/api/optimizer/enabled").json()["enabled"] is True


def test_pausing_and_resuming_the_service() -> None:
    client, ctx = _client()

    paused = client.post("/api/optimizer/enabled", json={"enabled": False, "reason": "maint"})
    assert paused.json() == {
        "enabled": False,
        "reason": "maint",
        "changed_at": paused.json()["changed_at"],
    }
    assert ctx.runtime.enabled.enabled is False

    client.post("/api/optimizer/enabled", json={"enabled": True})
    assert ctx.runtime.enabled.enabled is True


def test_per_greenhouse_enable_defaults_to_on() -> None:
    client, _ctx = _client()
    body = client.get("/api/optimizer/greenhouses/gh-a/enabled").json()

    assert body == {"greenhouse_id": "gh-a", "enabled": True, "reason": None, "changed_at": None}


def test_pausing_one_greenhouse() -> None:
    client, ctx = _client()
    response = client.post(
        "/api/optimizer/greenhouses/gh-a/enabled", json={"enabled": False, "reason": "swap"}
    )

    assert response.status_code == 200
    assert response.json()["enabled"] is False
    assert ctx.runtime.is_greenhouse_active("gh-a") is False
    assert ctx.runtime.is_greenhouse_active("gh-b") is True


# -- the operator gate ------------------------------------------------------


def test_reads_stay_open_while_the_service_is_paused() -> None:
    client, ctx = _client()
    ctx.runtime.set_enabled(False)

    # Every read surface stays live in read-only mode (spec 09).
    assert client.get("/api/optimizer/fleet").status_code == 200
    assert client.get("/api/optimizer/escalations").status_code == 200
    assert client.get("/api/optimizer/model").status_code == 200


def test_oidc_mode_rejects_untokened_operator_writes() -> None:
    settings = Settings(
        platform_auth={"mode": "oidc", "oidc_token_url": "https://auth.local/token"}
    )
    client, _ctx = _client(_context(settings=settings))

    assert client.post("/api/optimizer/enabled", json={"enabled": False}).status_code == 401
    assert client.post("/api/optimizer/model", json={"model": "mistral"}).status_code == 401
    # Reads remain ungated.
    assert client.get("/api/optimizer/model").status_code == 200


# -- app lifecycle and startup validation -----------------------------------


def test_lifespan_starts_and_stops_cleanly() -> None:
    ctx = _context()
    app = create_app(context=ctx, start_scheduler=False)

    with TestClient(app) as client:
        assert client.get("/api/optimizer/enabled").status_code == 200


def test_startup_validation_accepts_the_defaults() -> None:
    validate_startup(Settings())


def test_startup_is_blocked_by_an_unknown_prompt_version() -> None:
    with pytest.raises(ConfigurationError, match="planner prompt"):
        validate_startup(Settings(llm={"prompt_version": "v-nope"}))


def test_startup_is_blocked_by_a_model_outside_the_allowlist() -> None:
    with pytest.raises(ConfigurationError, match="available_models"):
        validate_startup(Settings(llm={"model": "not-vetted"}))


def test_startup_is_blocked_by_a_cloud_provider_without_a_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PLANNER_API_KEY", raising=False)
    settings = Settings(
        llm={
            "provider": "anthropic",
            "model": "claude-x",
            "available_models": {"anthropic": ["claude-x"]},
        }
    )

    with pytest.raises(ConfigurationError, match="PLANNER_API_KEY"):
        validate_startup(settings)


def test_startup_is_blocked_by_oidc_without_a_token_url() -> None:
    with pytest.raises(ConfigurationError, match="oidc_token_url"):
        validate_startup(Settings(platform_auth={"mode": "oidc"}))
