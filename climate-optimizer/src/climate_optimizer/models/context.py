"""Planning-context read shapes.

Mirrors ``contracts/platform-optimizer-planning-rest/components/schemas/planning-context.json``
— everything the Data Access component reads for one cycle: current setpoints + crop-safe
bounds, bucketed telemetry summaries, latest actuator states, and the data-quality signals the
input gate runs before the twin and planner.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import Field

from .base import SLUG_PATTERN, StrictModel
from .enums import (
    ActuatorHealth,
    ActuatorName,
    ControllerMode,
    Interval,
    Metric,
    SensorFaultKind,
    SetpointSource,
)
from .setpoints import Setpoints

# Optional per-metric zone identity: null for greenhouse-scoped metrics, a slug for zone-scoped.
_ZoneId = str | None


class Bound(StrictModel):
    """A crop-safe [min, max] envelope for one scalar target — both edges always present."""

    min: float
    max: float


class ZoneBounds(StrictModel):
    """The stage's crop-safe envelope for numeric per-zone irrigation targets (uniform per zone)."""

    moisture_low_threshold: Bound | None = None
    moisture_high_threshold: Bound | None = None
    drain_period_secs: Bound | None = None


class StageBounds(StrictModel):
    """The active stage's crop-safe envelope — an optional ``Bound`` per target, plus zones.

    An absent target means no crop-specific envelope for it (hold that target's baseline); an
    absent whole object means nothing is refined this cycle.
    """

    temperature_day_c: Bound | None = None
    temperature_night_c: Bound | None = None
    humidity_low_pct: Bound | None = None
    humidity_high_pct: Bound | None = None
    humidity_deadband_pct: Bound | None = None
    co2_target_ppm: Bound | None = None
    co2_vent_interlock_threshold_pct: Bound | None = None
    vpd_target_kpa: Bound | None = None
    dli_target_mol: Bound | None = None
    zones: ZoneBounds | None = None


class CurrentSetpoints(StrictModel):
    """The current intended state with provenance — the crop-safe baseline the optimizer refines."""

    source: SetpointSource
    updated_at: datetime
    targets: Setpoints
    bounds: StageBounds | None = None


class SummaryBucket(StrictModel):
    """One time-bucket's (min, mean, max) aggregate for a metric; ``count == 0`` marks a gap."""

    bucket_start: datetime
    min: float
    mean: float
    max: float
    count: int = Field(ge=0)


class MetricSummarySeries(StrictModel):
    """One metric/scope's bucketed history over the window."""

    metric: Metric
    zone_id: _ZoneId = Field(pattern=SLUG_PATTERN)
    buckets: list[SummaryBucket]


class ActuatorSnapshot(StrictModel):
    """Latest commanded-vs-observed position for one actuator, plus readback health."""

    actuator: ActuatorName
    zone_id: _ZoneId = Field(pattern=SLUG_PATTERN)
    commanded: float = Field(ge=0, le=100)
    observed: float | None = Field(default=..., ge=0, le=100)
    health: ActuatorHealth
    ts: datetime


class MetricFreshness(StrictModel):
    """Per-metric freshness the input gate reads: latest sample age against the threshold."""

    metric: Metric
    zone_id: _ZoneId = Field(pattern=SLUG_PATTERN)
    latest_ts: datetime | None
    age_seconds: float | None = Field(default=..., ge=0)
    sample_count: int = Field(ge=0)


class SensorFault(StrictModel):
    """An active per-sensor fault the controller published."""

    metric: Metric
    zone_id: _ZoneId = Field(pattern=SLUG_PATTERN)
    kind: SensorFaultKind
    since: datetime


class DataQuality(StrictModel):
    """The data-quality / freshness signals the input gate runs before planning."""

    controller_mode: ControllerMode
    time_scale: float | None = Field(default=..., gt=0)
    freshness: list[MetricFreshness]
    faults: list[SensorFault]


class PlanningContext(StrictModel):
    """One bounded read of a greenhouse's planning context for a single cycle."""

    greenhouse_id: str = Field(pattern=SLUG_PATTERN)
    schema_version: int = Field(ge=1)
    from_: datetime = Field(alias="from")
    to: datetime
    interval: Interval
    setpoints: CurrentSetpoints
    telemetry: list[MetricSummarySeries]
    actuators: list[ActuatorSnapshot]
    data_quality: DataQuality
