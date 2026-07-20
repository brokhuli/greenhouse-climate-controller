"""The input gate returns the right canonical reason code for each failure, and passes clean data."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from climate_optimizer.config import Settings
from climate_optimizer.gating import GateOutcome, evaluate_input_gate
from climate_optimizer.models import (
    ActuatorHealth,
    ControllerMode,
    Metric,
    ReasonClass,
    ReasonCode,
    SensorFault,
    SensorFaultKind,
)
from conftest import build_context

SETTINGS = Settings()


def _gate(**kwargs: Any) -> GateOutcome:
    ctx = build_context(**kwargs)
    return evaluate_input_gate(ctx, SETTINGS, expected_greenhouse_id="gh-a")


def test_clean_context_is_trusted() -> None:
    outcome = _gate()
    assert outcome.trusted
    assert outcome.reason_code is None


def test_stale_freshness() -> None:
    outcome = _gate(freshness_age=3000.0)
    assert outcome.reason_code is ReasonCode.INPUT_STALE
    assert outcome.reason_class is ReasonClass.TRANSIENT


def test_incomplete_missing_metric() -> None:
    assert _gate(drop_metric=Metric.PAR).reason_code is ReasonCode.INPUT_INCOMPLETE


def test_incomplete_low_coverage() -> None:
    assert _gate(gap_metric=Metric.CO2).reason_code is ReasonCode.INPUT_INCOMPLETE


def test_sensor_fault_on_depended_metric() -> None:
    fault = SensorFault(
        metric=Metric.TEMPERATURE,
        zone_id=None,
        kind=SensorFaultKind.STUCK,
        since=datetime(2026, 6, 17, tzinfo=UTC),
    )
    assert _gate(faults=[fault]).reason_code is ReasonCode.SENSOR_FAULT


def test_controller_degraded_is_sensor_fault() -> None:
    assert _gate(controller_mode=ControllerMode.DEGRADED).reason_code is ReasonCode.SENSOR_FAULT


def test_actuator_fault() -> None:
    outcome = _gate(valve_health=ActuatorHealth.NO_RESPONSE)
    assert outcome.reason_code is ReasonCode.ACTUATOR_FAULT


def test_clock_mode_unsupported() -> None:
    assert _gate(time_scale=2.0).reason_code is ReasonCode.CLOCK_MODE_UNSUPPORTED


def test_real_hardware_null_time_scale_ok() -> None:
    assert _gate(time_scale=None).trusted


def test_contract_drift_wrong_greenhouse() -> None:
    ctx = build_context(greenhouse_id="gh-b")
    outcome = evaluate_input_gate(ctx, SETTINGS, expected_greenhouse_id="gh-a")
    assert outcome.reason_code is ReasonCode.CONTRACT_DRIFT
    assert outcome.reason_class is ReasonClass.PERSISTENT


def test_contract_drift_unknown_schema_version() -> None:
    assert _gate(schema_version=99).reason_code is ReasonCode.CONTRACT_DRIFT
