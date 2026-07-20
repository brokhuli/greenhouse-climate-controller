"""Shared test fixtures and builders.

The contract example JSON under ``contracts/`` doubles as test vectors; the builders here construct
a healthy, gate-passing ``PlanningContext`` (and its parts) that individual tests perturb.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from climate_optimizer.models import (
    ActuatorHealth,
    ActuatorName,
    ActuatorSnapshot,
    Bound,
    ControllerMode,
    CurrentSetpoints,
    DataQuality,
    Interval,
    Metric,
    MetricFreshness,
    MetricSummarySeries,
    PlanningContext,
    SensorFault,
    Setpoints,
    SetpointSource,
    StageBounds,
    SummaryBucket,
    ZoneBounds,
    ZoneTargets,
)

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
