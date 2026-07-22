"""Shared test fixtures and builders.

The contract example JSON under ``contracts/`` doubles as test vectors; the builders here construct
a healthy, gate-passing ``PlanningContext`` (and its parts) that individual tests perturb, plus the
service-slice doubles: a stub Phase-2 client and fake planner chains that keep planner tests off a
live LLM (spec 12 §Testing).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from langchain_core.runnables import RunnableLambda

from climate_optimizer.config import Settings
from climate_optimizer.dataaccess import PlatformClient, PlatformError, WriteOutcome
from climate_optimizer.models import (
    ActuatorHealth,
    ActuatorName,
    ActuatorSnapshot,
    BackendRole,
    Bound,
    ControllerMode,
    CurrentSetpoints,
    DataQuality,
    Interval,
    Metric,
    MetricFreshness,
    MetricSummarySeries,
    OptimizerPlan,
    PlanningContext,
    Provider,
    SensorFault,
    Setpoints,
    SetpointSource,
    SetpointsPatch,
    StageBounds,
    SummaryBucket,
    TrajectoryPoint,
    ZoneBounds,
    ZoneTargets,
)
from climate_optimizer.planner import BackendOutput, PlannerChain

CONTRACTS_DIR = Path(__file__).resolve().parents[2] / "contracts"
_TO = datetime(2026, 6, 17, 12, 0, 0, tzinfo=UTC)

# Healthy greenhouse-scoped seed means used across the builders.
_METRIC_MEANS = {
    Metric.TEMPERATURE: 23.0,
    Metric.HUMIDITY: 60.0,
    Metric.CO2: 1000.0,
    Metric.PAR: 500.0,
}


def load_fixture(relpath: str) -> Any:
    """Load a contract example fixture (used as a test vector)."""
    return json.loads((CONTRACTS_DIR / relpath).read_text(encoding="utf-8"))


def build_setpoints(zone_id: str = "bench-a") -> Setpoints:
    return Setpoints(
        temperature_day_c=24.0,
        temperature_night_c=18.0,
        day_start="06:00",
        day_end="20:00",
        humidity_low_pct=50.0,
        humidity_high_pct=85.0,
        humidity_deadband_pct=5.0,
        co2_target_ppm=1000,
        co2_vent_interlock_threshold_pct=15.0,
        vpd_target_kpa=1.0,
        dli_target_mol=20.0,
        zones=[
            ZoneTargets(
                zone_id=zone_id,
                moisture_low_threshold=0.35,
                moisture_high_threshold=0.55,
                drain_period_secs=300,
                schedule="06:00,12:00,18:00",
            )
        ],
    )


def build_bounds() -> StageBounds:
    return StageBounds(
        temperature_day_c=Bound(min=21.0, max=26.0),
        co2_target_ppm=Bound(min=900.0, max=1100.0),
        vpd_target_kpa=Bound(min=0.7, max=1.1),
        dli_target_mol=Bound(min=15.0, max=22.0),
        zones=ZoneBounds(
            moisture_low_threshold=Bound(min=0.3, max=0.5),
            moisture_high_threshold=Bound(min=0.5, max=0.7),
            drain_period_secs=Bound(min=200.0, max=400.0),
        ),
    )


def build_context(
    *,
    greenhouse_id: str = "gh-a",
    schema_version: int = 1,
    time_scale: float | None = 1.0,
    controller_mode: ControllerMode = ControllerMode.NORMAL,
    faults: list[SensorFault] | None = None,
    valve_health: ActuatorHealth = ActuatorHealth.OK,
    freshness_age: float = 60.0,
    drop_metric: Metric | None = None,
    gap_metric: Metric | None = None,
    zone_id: str = "bench-a",
    hours: int = 2,
) -> PlanningContext:
    """A healthy, gate-passing planning context that tests perturb via kwargs."""
    frm = _TO - timedelta(hours=hours)

    def buckets(mean: float, gap: bool = False) -> list[SummaryBucket]:
        return [
            SummaryBucket(
                bucket_start=frm + timedelta(hours=i),
                min=mean - 1.0,
                mean=mean,
                max=mean + 1.0,
                count=0 if gap else 60,
            )
            for i in range(hours)
        ]

    telemetry: list[MetricSummarySeries] = []
    freshness: list[MetricFreshness] = []
    for metric, mean in _METRIC_MEANS.items():
        if metric is drop_metric:
            continue
        telemetry.append(
            MetricSummarySeries(
                metric=metric, zone_id=None, buckets=buckets(mean, metric is gap_metric)
            )
        )
        freshness.append(
            MetricFreshness(
                metric=metric,
                zone_id=None,
                latest_ts=_TO - timedelta(seconds=freshness_age),
                age_seconds=freshness_age,
                sample_count=hours * 60,
            )
        )
    telemetry.append(
        MetricSummarySeries(metric=Metric.SOIL_MOISTURE, zone_id=zone_id, buckets=buckets(0.45))
    )
    freshness.append(
        MetricFreshness(
            metric=Metric.SOIL_MOISTURE,
            zone_id=zone_id,
            latest_ts=_TO - timedelta(seconds=freshness_age),
            age_seconds=freshness_age,
            sample_count=hours * 12,
        )
    )

    actuators = [
        ActuatorSnapshot(
            actuator=ActuatorName.ROOF_VENTS,
            zone_id=None,
            commanded=10.0,
            observed=10.0,
            health=ActuatorHealth.OK,
            ts=_TO,
        ),
        ActuatorSnapshot(
            actuator=ActuatorName.IRRIGATION_VALVE,
            zone_id=zone_id,
            commanded=0.0,
            observed=None,
            health=valve_health,
            ts=_TO,
        ),
    ]

    return PlanningContext(
        greenhouse_id=greenhouse_id,
        schema_version=schema_version,
        from_=frm,
        to=_TO,
        interval=Interval.HOURLY,
        setpoints=CurrentSetpoints(
            source=SetpointSource.PROFILE,
            updated_at=_TO,
            targets=build_setpoints(zone_id),
            bounds=build_bounds(),
        ),
        telemetry=telemetry,
        actuators=actuators,
        data_quality=DataQuality(
            controller_mode=controller_mode,
            time_scale=time_scale,
            freshness=freshness,
            faults=faults or [],
        ),
    )


def context_payload(ctx: PlanningContext) -> dict[str, Any]:
    """A planning context as the platform would send it on the wire.

    Only ``setpoints.bounds`` needs None-pruning: its members are all optional, so an absent bound
    must be *omitted*, while every other nullable field in the contract is required-and-nullable and
    must stay present as ``null``.
    """
    payload: dict[str, Any] = ctx.model_dump(mode="json", by_alias=True)
    setpoints = payload["setpoints"]
    bounds = setpoints.get("bounds")
    if bounds is None:
        setpoints.pop("bounds", None)
        return payload

    pruned = {key: value for key, value in bounds.items() if value is not None}
    zones = bounds.get("zones")
    if zones is not None:
        pruned["zones"] = {key: value for key, value in zones.items() if value is not None}
    setpoints["bounds"] = pruned
    return payload


def build_patch(**overrides: Any) -> SetpointsPatch:
    """An in-bounds refinement patch against :func:`build_bounds`."""
    fields: dict[str, Any] = {
        "temperature_day_c": 23.0,
        "co2_target_ppm": 1000,
        "vpd_target_kpa": 0.9,
    }
    fields.update(overrides)
    return SetpointsPatch(**fields)


def build_plan(
    *,
    at: datetime | None = None,
    confidence: float = 0.95,
    patch: SetpointsPatch | None = None,
    hours: int = 3,
) -> OptimizerPlan:
    """A well-formed plan whose ``immediate_setpoints`` equals ``trajectory[0].setpoints``."""
    start = at or _TO
    bundle = patch or build_patch()
    return OptimizerPlan(
        trajectory=[
            TrajectoryPoint(at=start + timedelta(hours=i), setpoints=bundle) for i in range(hours)
        ],
        immediate_setpoints=bundle,
        confidence=confidence,
        explanation="test plan",
    )


def build_output(
    plan: OptimizerPlan | None = None, *, role: BackendRole = BackendRole.PRIMARY
) -> BackendOutput:
    """The chain's provenance-stamped output for a canned plan."""
    return BackendOutput(
        plan=plan or build_plan(),
        provider=Provider.OLLAMA,
        model="qwen2.5:7b",
        role=role,
    )


def fake_chain(output: BackendOutput | None = None) -> PlannerChain:
    """A chain that returns a canned plan — keeps planner tests off a live LLM."""
    resolved = output or build_output()
    return RunnableLambda(lambda _payload: resolved)


def failing_chain(error: Exception | None = None) -> PlannerChain:
    """A chain that raises, standing in for an unreachable or non-conforming backend."""
    failure = error or RuntimeError("backend unreachable")

    def boom(_payload: Any) -> BackendOutput:
        raise failure

    return RunnableLambda(boom)


def chain_factory(chain: PlannerChain) -> Callable[[str], PlannerChain]:
    """Adapt a fixed chain to the ``Planner(chain_factory=...)`` seam."""
    return lambda _model: chain


class StubPlatformClient(PlatformClient):
    """A :class:`PlatformClient` with the two network calls replaced by canned answers.

    The real response→outcome mapping is covered against actual HTTP in ``test_dataaccess``; these
    stubs let the cycle, scheduler, and service tests drive each branch directly.
    """

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        context: PlanningContext | None = None,
        read_error: PlatformError | None = None,
        write: WriteOutcome | None = None,
        fleet: list[str] | None = None,
        fleet_error: PlatformError | None = None,
    ) -> None:
        super().__init__(settings or Settings(), client=httpx.AsyncClient())
        # Without an explicit context, answer each greenhouse with its *own* context — a fixed
        # "gh-a" body would fail every other greenhouse's identity check in the input gate.
        self.context = context
        self.read_error = read_error
        self.write = write or WriteOutcome.applied_ok(setpoints=None, message="accepted (202)")
        self.fleet = fleet if fleet is not None else ["gh-a"]
        self.fleet_error = fleet_error
        self.submitted: list[tuple[str, SetpointsPatch]] = []
        self.reads: list[str] = []

    async def get_planning_context(
        self, greenhouse_id: str, *, window: str = "12h", interval: str = "1h"
    ) -> PlanningContext:
        self.reads.append(greenhouse_id)
        if self.read_error is not None:
            raise self.read_error
        if self.context is not None:
            return self.context
        return build_context(greenhouse_id=greenhouse_id)

    async def submit_setpoints(self, greenhouse_id: str, patch: SetpointsPatch) -> WriteOutcome:
        self.submitted.append((greenhouse_id, patch))
        return self.write

    async def list_greenhouse_ids(self) -> list[str]:
        if self.fleet_error is not None:
            raise self.fleet_error
        return list(self.fleet)
