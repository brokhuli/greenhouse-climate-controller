"""The service's wired-up components, plus startup validation and the health probe.

:class:`ServiceContext` is the single object the routes read from, built once in the app's lifespan
and injectable wholesale so tests can substitute a fake planner and a mocked platform.

**Fail-fast configuration validation** (spec 09) runs before anything starts: an invalid config
*blocks the service from coming up* rather than letting it run on silent defaults — the same
startup-gate discipline the platform applies to schema migrations. ``pydantic-settings`` already
rejects out-of-range values at load; :func:`validate_startup` adds the cross-field checks it cannot
express — a resolvable prompt template, a credential for a cloud provider, and a pinned model that is
actually in the allowlist (the model id pins the evaluation baselines, so a mismatch is a reviewable
event, not silent drift).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx

from ..auth import JwtOperatorVerifier, OperatorVerifier, TokenProvider
from ..config import Settings
from ..dataaccess import PlatformClient, PlatformError
from ..models import Provider
from ..params import TwinParams, default_twin_params
from ..planner import Planner, PromptNotFoundError, load_prompt_template
from ..runtime import RuntimeState
from ..scheduler import Scheduler
from ..store import ServiceStore
from .schemas import DegradedReason, HealthResponse, HealthStatus

logger = logging.getLogger(__name__)

# A loop is only "stalled" once it has missed several cadences; one slow cycle is not a stall.
_STALL_CADENCE_MULTIPLE = 3
_PROBE_TIMEOUT_SECONDS = 5.0


class ConfigurationError(Exception):
    """The configuration cannot support a running service; startup is blocked (spec 09)."""


def validate_startup(settings: Settings) -> None:
    """Cross-field configuration checks that must pass before the service comes up."""
    if not settings.data.platform_api_url.strip():
        raise ConfigurationError("data.platform_api_url must be set")

    try:
        load_prompt_template(settings.llm.prompt_version)
    except PromptNotFoundError as err:
        raise ConfigurationError(str(err)) from err

    if (
        settings.llm.provider is not Provider.OLLAMA
        and not settings.planner_api_key.get_secret_value()
    ):
        raise ConfigurationError(
            f"provider {settings.llm.provider.value!r} requires PLANNER_API_KEY to be set"
        )

    allowlist = settings.llm.available_models.get(settings.llm.provider.value, [])
    if settings.llm.model not in allowlist:
        raise ConfigurationError(
            f"llm.model {settings.llm.model!r} is not in available_models for provider "
            f"{settings.llm.provider.value!r} — expand the allowlist (with its evaluation "
            "baseline) before pinning it"
        )

    if settings.platform_auth.mode == "oidc" and not settings.platform_auth.oidc_token_url:
        raise ConfigurationError("platform_auth.oidc_token_url is required in oidc mode")


@dataclass
class ServiceContext:
    """Everything the routes and background loops share."""

    settings: Settings
    runtime: RuntimeState
    store: ServiceStore
    client: PlatformClient
    planner: Planner
    scheduler: Scheduler
    params: TwinParams
    token_provider: TokenProvider | None = None
    verifier: OperatorVerifier | None = None

    async def aclose(self) -> None:
        await self.scheduler.stop()
        await self.client.aclose()
        if self.token_provider is not None:
            await self.token_provider.aclose()


def build_context(settings: Settings) -> ServiceContext:
    """Construct the production wiring from settings (tests build their own)."""
    token_provider = TokenProvider(settings)
    client = PlatformClient(settings, token_source=token_provider)
    runtime = RuntimeState(settings)
    store = ServiceStore()
    planner = Planner(settings)
    params = default_twin_params()
    scheduler = Scheduler(
        settings=settings,
        client=client,
        planner=planner,
        runtime=runtime,
        store=store,
        params=params,
    )
    verifier = JwtOperatorVerifier(settings) if settings.platform_auth.mode == "oidc" else None
    return ServiceContext(
        settings=settings,
        runtime=runtime,
        store=store,
        client=client,
        planner=planner,
        scheduler=scheduler,
        params=params,
        token_provider=token_provider,
        verifier=verifier,
    )


async def probe_platform(client: PlatformClient) -> bool:
    """Is Phase 2 reachable? Uses the registry read the scheduler already depends on."""
    try:
        await client.list_greenhouse_ids()
    except PlatformError:
        return False
    return True


async def probe_llm(settings: Settings) -> bool:
    """Is the planning backend reachable?

    The default local Ollama backend is probed directly (``/api/tags`` is free). A cloud backend has
    no free liveness call, so a configured credential is treated as reachable rather than spending
    tokens on a health check every scrape.
    """
    if settings.llm.provider is not Provider.OLLAMA:
        return bool(settings.planner_api_key.get_secret_value())

    url = settings.llm.endpoint.rstrip("/") + "/api/tags"
    try:
        async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT_SECONDS) as probe:
            response = await probe.get(url)
    except (httpx.TimeoutException, httpx.TransportError):
        return False
    return response.status_code == 200


async def build_health(ctx: ServiceContext, *, now: datetime | None = None) -> HealthResponse:
    """Compose the watchdog view (spec 09).

    A **paused** optimizer is reported as healthy with its read-only reason: the last-successful-cycle
    age is *expected* to grow while planning is disabled, so it must not be read as a stall.
    """
    moment = now or datetime.now(UTC)
    cadence_secs = ctx.settings.planning.cycle_interval_minutes * 60
    enabled = ctx.runtime.enabled.enabled
    last_cycle = ctx.store.last_successful_cycle_at

    platform_reachable = await probe_platform(ctx.client)
    llm_reachable = await probe_llm(ctx.settings)

    degraded_reason: DegradedReason | None = None
    if not platform_reachable:
        degraded_reason = DegradedReason.PLATFORM_UNREACHABLE
    elif not llm_reachable:
        degraded_reason = DegradedReason.LLM_UNREACHABLE
    elif last_cycle is None:
        degraded_reason = DegradedReason.COLD_START
    elif enabled and (moment - last_cycle).total_seconds() > cadence_secs * _STALL_CADENCE_MULTIPLE:
        degraded_reason = DegradedReason.CYCLE_STALLED

    return HealthResponse(
        status=HealthStatus.DEGRADED if degraded_reason else HealthStatus.HEALTHY,
        degraded_reason=degraded_reason,
        enabled=enabled,
        read_only_reason=ctx.runtime.read_only_reason,
        platform_reachable=platform_reachable,
        llm_reachable=llm_reachable,
        last_successful_cycle_at=last_cycle,
        escalation_backlog=ctx.store.escalations.backlog(),
        cadence_secs=cadence_secs,
    )
