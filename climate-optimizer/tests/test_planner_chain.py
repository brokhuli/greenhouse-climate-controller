"""The planner chain and front end — prompt pinning, backends, horizon, and failure mapping."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from langchain_core.runnables import RunnableLambda
from langchain_ollama import ChatOllama

from climate_optimizer.config import Settings
from climate_optimizer.models import BackendRole, PlanningContext, Provider
from climate_optimizer.planner import (
    ContextBudgetExceededError,
    Planner,
    PlannerChain,
    PlannerUnavailableError,
    PlanProposal,
    PromptNotFoundError,
    build_chain,
    build_chat_model,
    choose_horizon,
    load_prompt_template,
)
from climate_optimizer.planner.chain import BackendOutput, ProviderNotConfiguredError
from conftest import (
    build_context,
    build_output,
    build_plan,
    build_setpoints,
    chain_factory,
    failing_chain,
    fake_chain,
)

NOW = datetime(2026, 6, 17, 12, 0, tzinfo=UTC)


def _planner(chain: PlannerChain | None = None, settings: Settings | None = None) -> Planner:
    return Planner(settings or Settings(), chain_factory=chain_factory(chain or fake_chain()))


async def _propose(
    planner: Planner, *, ctx: PlanningContext | None = None, model: str = "qwen2.5:7b"
) -> PlanProposal:
    context = ctx or build_context()
    return await planner.propose(
        context,
        baseline_forecast=[],
        horizon=choose_horizon(NOW, context.setpoints.targets, Settings()),
        model=model,
        now=NOW,
    )


# -- prompt asset -----------------------------------------------------------


def test_the_pinned_prompt_version_resolves_to_a_checked_in_asset() -> None:
    template = load_prompt_template("v1")
    assert "immediate_setpoints" in template
    assert "crop-safe" in template


def test_an_unknown_prompt_version_raises() -> None:
    with pytest.raises(PromptNotFoundError):
        load_prompt_template("v-nope")


# -- backend construction ---------------------------------------------------


def test_ollama_backend_needs_no_credential() -> None:
    model = build_chat_model(
        Settings(), provider=Provider.OLLAMA, model="qwen2.5:7b", endpoint="http://ollama:11434"
    )
    assert model is not None


@pytest.mark.parametrize("provider", [Provider.ANTHROPIC, Provider.OPENAI])
def test_a_cloud_backend_without_an_api_key_is_refused(provider: Provider) -> None:
    with pytest.raises(ProviderNotConfiguredError):
        build_chat_model(Settings(), provider=provider, model="m", endpoint="")


def test_sampling_is_pinned_on_the_constructed_backend() -> None:
    settings = Settings(llm={"temperature": 0.0, "top_p": 1.0, "output_token_budget": 640})
    model = build_chat_model(
        settings, provider=Provider.OLLAMA, model="qwen2.5:7b", endpoint="http://ollama:11434"
    )

    # Determinism is what makes plans regression-testable (spec 04 §Determinism).
    assert isinstance(model, ChatOllama)
    assert model.temperature == 0.0
    assert model.top_p == 1.0
    assert model.num_predict == 640


def test_chain_builds_for_the_default_backend() -> None:
    assert build_chain(Settings(), model="qwen2.5:7b") is not None


def test_chain_wires_a_configured_fallback() -> None:
    settings = Settings(
        llm={"fallback_provider": "ollama", "fallback_model": "llama3.2"},
    )
    chain = build_chain(settings, model="qwen2.5:7b")

    # with_fallbacks wraps the primary leg rather than replacing it.
    assert hasattr(chain, "fallbacks")


# -- adaptive horizon -------------------------------------------------------


def test_horizon_defaults_to_the_configured_span() -> None:
    # 12:00 with a 06:00/20:00 day window is 8 h from the next flip — the plain horizon.
    horizon = choose_horizon(NOW, build_setpoints(), Settings())
    assert horizon.end - horizon.start == timedelta(hours=12)


def test_horizon_doubles_near_a_day_schedule_flip() -> None:
    # 17:00 is 3 h before the 20:00 flip, inside the 4 h proximity window.
    near_dusk = NOW.replace(hour=17)
    horizon = choose_horizon(near_dusk, build_setpoints(), Settings())
    assert horizon.end - horizon.start == timedelta(hours=24)


def test_horizon_proximity_wraps_across_midnight() -> None:
    # 03:00 is 3 h before the 06:00 sunrise flip.
    horizon = choose_horizon(NOW.replace(hour=3), build_setpoints(), Settings())
    assert horizon.end - horizon.start == timedelta(hours=24)


# -- proposing --------------------------------------------------------------


async def test_propose_returns_the_stamped_plan_and_context() -> None:
    proposal = await _propose(_planner())

    assert proposal.output.plan.confidence == 0.95
    assert proposal.output.role is BackendRole.PRIMARY
    assert proposal.context.token_estimate > 0


async def test_a_fallback_response_is_recorded_as_such() -> None:
    output = build_output(role=BackendRole.FALLBACK)
    proposal = await _propose(_planner(fake_chain(output)))

    # Failover is recorded, not hidden: the fallback is a different model (spec 04).
    assert proposal.output.role is BackendRole.FALLBACK


async def test_an_unreachable_backend_holds_the_cycle() -> None:
    with pytest.raises(PlannerUnavailableError):
        await _propose(_planner(failing_chain()))


async def test_an_unparseable_response_also_holds_the_cycle() -> None:
    planner = _planner(failing_chain(ValueError("could not parse structured output")))
    with pytest.raises(PlannerUnavailableError):
        await _propose(planner)


async def test_an_over_budget_context_propagates_as_a_config_fault() -> None:
    planner = _planner(settings=Settings(planning={"context_token_budget": 5}))

    # Distinct from a backend outage: the budget is a configuration problem.
    with pytest.raises(ContextBudgetExceededError):
        await _propose(planner)


async def test_chains_are_cached_per_model() -> None:
    built: list[str] = []

    def factory(model: str) -> PlannerChain:
        built.append(model)
        return fake_chain()

    planner = Planner(Settings(), chain_factory=factory)
    await _propose(planner, model="qwen2.5:7b")
    await _propose(planner, model="qwen2.5:7b")
    await _propose(planner, model="mistral")

    # A runtime model switch builds a new chain; repeats reuse the cached one.
    assert built == ["qwen2.5:7b", "mistral"]


async def test_the_plan_context_reaches_the_chain() -> None:
    seen: list[dict[str, Any]] = []

    def capture(payload: dict[str, Any]) -> BackendOutput:
        seen.append(payload)
        return build_output(build_plan())

    chain: PlannerChain = RunnableLambda(capture)
    planner = Planner(Settings(), chain_factory=chain_factory(chain))
    await _propose(planner)

    assert "gh-a" in seen[0]["plan_context"]
