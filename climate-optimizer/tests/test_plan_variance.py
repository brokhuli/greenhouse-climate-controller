"""Spec-08 §3 plan-variance baselines — the tolerance-band regression check.

Exercises the harness in [`plan_variance.py`](./plan_variance.py): a committed baseline is
contract-valid and matches itself; a within-tolerance re-run passes while a beyond-tolerance one fails
and names the offending field; the backend key round-trips and distinct backends resolve to distinct
baselines; and a plan driven through the real cycle lands within band of its baseline.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from climate_optimizer.config import Settings
from climate_optimizer.domain.twin import default_twin_params
from climate_optimizer.models import OptimizerPlan, OutcomeStatus, Provider, SetpointsPatch
from climate_optimizer.orchestration.cycle import run_cycle
from climate_optimizer.orchestration.runtime import RuntimeState
from climate_optimizer.orchestration.store import ServiceStore
from climate_optimizer.planner import Planner
from conftest import StubPlatformClient, build_output, chain_factory, fake_chain
from plan_variance import (
    BackendKey,
    baseline_path,
    compare_plan_to_baseline,
    load_baseline,
)

SCENARIO = "overnight_dli_shift"
KEY = BackendKey(Provider.OLLAMA, "llama3.2", "v1", "t0-p1")
NOW = datetime(2026, 6, 17, 12, 0, tzinfo=UTC)


def _with_immediate(plan: OptimizerPlan, **overrides: Any) -> OptimizerPlan:
    patch = plan.immediate_setpoints.model_copy(update=overrides)
    return plan.model_copy(update={"immediate_setpoints": patch})


def _drop_immediate_field(plan: OptimizerPlan, name: str) -> OptimizerPlan:
    data = plan.immediate_setpoints.model_dump(exclude_none=True)
    data.pop(name, None)
    return plan.model_copy(update={"immediate_setpoints": SetpointsPatch(**data)})


# -- the baseline itself ----------------------------------------------------


def test_committed_baseline_loads_and_is_contract_valid() -> None:
    baseline = load_baseline(KEY, SCENARIO)  # raises if the JSON is off-contract
    assert baseline.confidence == 0.9
    assert baseline.immediate_setpoints.dli_target_mol == 18.0


def test_baseline_matches_itself() -> None:
    baseline = load_baseline(KEY, SCENARIO)
    report = compare_plan_to_baseline(baseline, baseline)
    assert report.within_band, report.summary()
    assert report.failures() == []


# -- bounded comparison -----------------------------------------------------


def test_within_tolerance_perturbation_passes() -> None:
    baseline = load_baseline(KEY, SCENARIO)
    # dli +1.0 (band 2.0), co2 +80 (band 100), confidence −0.05 (band 0.1): all inside.
    candidate = _with_immediate(baseline, dli_target_mol=19.0, co2_target_ppm=1080)
    candidate = candidate.model_copy(update={"confidence": 0.85})
    report = compare_plan_to_baseline(candidate, baseline)
    assert report.within_band, report.summary()


def test_beyond_tolerance_setpoint_fails_and_names_field() -> None:
    baseline = load_baseline(KEY, SCENARIO)
    candidate = _with_immediate(baseline, dli_target_mol=24.0)  # +6.0, band is 2.0
    report = compare_plan_to_baseline(candidate, baseline)
    assert not report.within_band
    assert "dli_target_mol" in {d.name for d in report.failures()}


def test_confidence_drift_beyond_band_fails() -> None:
    baseline = load_baseline(KEY, SCENARIO)
    candidate = baseline.model_copy(update={"confidence": 0.5})  # −0.4, band is 0.1
    report = compare_plan_to_baseline(candidate, baseline)
    assert not report.within_band
    assert "confidence" in {d.name for d in report.failures()}


def test_missing_field_is_a_structural_mismatch() -> None:
    baseline = load_baseline(KEY, SCENARIO)
    candidate = _drop_immediate_field(baseline, "co2_target_ppm")
    report = compare_plan_to_baseline(candidate, baseline)
    assert not report.within_band
    dev = next(d for d in report.failures() if d.name == "co2_target_ppm")
    assert dev.delta is None  # structural, not a numeric drift


# -- the backend key --------------------------------------------------------


def test_backend_key_slug_and_distinct_paths() -> None:
    assert KEY.slug == "ollama__llama3.2__v1__t0-p1"
    other = BackendKey(Provider.OLLAMA, "qwen2.5:7b", "v1", "t0-p1")
    assert other.slug == "ollama__qwen2.5-7b__v1__t0-p1"  # ':' is sanitized for the filesystem
    assert baseline_path(KEY, SCENARIO) != baseline_path(other, SCENARIO)


def test_backend_key_from_settings_matches_the_default_backend() -> None:
    # The configured provider/prompt/sampling plus the active runtime model form the key.
    assert BackendKey.from_settings(Settings(), model="llama3.2") == KEY


# -- ties the harness to the live pipeline ----------------------------------


async def test_pipeline_plan_lands_within_band_of_its_baseline() -> None:
    settings = Settings()
    key = BackendKey.from_settings(settings, model="llama3.2")
    baseline = load_baseline(key, SCENARIO)

    # Drive the baseline plan through the full cycle; the applied plan must match its baseline.
    record = await run_cycle(
        "gh-a",
        settings=settings,
        client=StubPlatformClient(settings),
        planner=Planner(settings, chain_factory=chain_factory(fake_chain(build_output(baseline)))),
        runtime=RuntimeState(settings),
        store=ServiceStore(),
        params=default_twin_params(),
        now=NOW,
    )

    assert record.outcome.status is OutcomeStatus.APPLIED, record.outcome
    assert record.plan is not None
    report = compare_plan_to_baseline(record.plan, baseline)
    assert report.within_band, report.summary()
