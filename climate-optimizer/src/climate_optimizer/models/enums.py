"""Closed enumerations shared across the optimizer domain models.

Every value is copied verbatim from the wire contracts so the Python enums and the JSON
schemas stay one source of truth (RFC-007). ``ReasonCode`` is the canonical escalation
table (optimizer interfaces spec §Escalation reason codes / plan-record.schema.json).
"""

from __future__ import annotations

from enum import StrEnum


class Metric(StrEnum):
    """Measured / derived quantities (contracts .../common.json#/Metric)."""

    TEMPERATURE = "temperature"
    HUMIDITY = "humidity"
    CO2 = "co2"
    PAR = "par"
    VPD = "vpd"
    SOIL_MOISTURE = "soil_moisture"


class ActuatorName(StrEnum):
    """Closed set of actuators (contracts .../common.json#/ActuatorName)."""

    HEATER = "heater"
    FANS = "fans"
    ROOF_VENTS = "roof_vents"
    MISTERS = "misters"
    CO2_INJECTOR = "co2_injector"
    GROW_LIGHTS = "grow_lights"
    SHADE_SCREEN = "shade_screen"
    IRRIGATION_VALVE = "irrigation_valve"


class ControllerMode(StrEnum):
    """Controller operating mode from the system-state snapshot."""

    NORMAL = "normal"
    DEGRADED = "degraded"
    INTERLOCK = "interlock"


class ActuatorHealth(StrEnum):
    """Actuator readback health the input gate reads."""

    OK = "ok"
    STUCK = "stuck"
    NO_RESPONSE = "no_response"


class SensorFaultKind(StrEnum):
    """Per-sensor fault classes, matching the controller's fault events."""

    STUCK = "stuck"
    OUT_OF_RANGE = "out_of_range"
    SENSOR_DISAGREEMENT = "sensor_disagreement"
    TEMPERATURE_UNAVAILABLE = "temperature_unavailable"


class Interval(StrEnum):
    """Summary-bucket width for the planning-context telemetry series."""

    HOURLY = "1h"
    SIX_HOURLY = "6h"
    DAILY = "1d"


class SetpointSource(StrEnum):
    """Provenance of the current intended state (planning-context CurrentSetpoints)."""

    OPTIMIZER = "optimizer"
    OPERATOR_EDIT = "operator_edit"
    PROFILE = "profile"


class Provider(StrEnum):
    """LLM backend provider (offline choice; PlanRecord.backend.provider)."""

    OLLAMA = "ollama"
    ANTHROPIC = "anthropic"
    OPENAI = "openai"


class BackendRole(StrEnum):
    """Whether the primary or the configured fallback produced a plan."""

    PRIMARY = "primary"
    FALLBACK = "fallback"


class OutcomeStatus(StrEnum):
    """What the gates decided for a cycle (PlanRecord.outcome.status)."""

    APPLIED = "applied"
    ESCALATED = "escalated"
    EXTENDED = "extended"


class ReasonClass(StrEnum):
    """Operator-triage hint: transient may clear next cycle; persistent will not self-heal."""

    TRANSIENT = "transient"
    PERSISTENT = "persistent"


class ReasonCode(StrEnum):
    """Canonical escalation reason codes — single source of truth mirrored by the contract.

    See the optimizer interfaces spec (Escalation reason codes) and
    ``contracts/optimizer-internal-plan-schema/plan-record.schema.json#/$defs/ReasonCode``.
    """

    INPUT_STALE = "input_stale"
    INPUT_INCOMPLETE = "input_incomplete"
    SENSOR_FAULT = "sensor_fault"
    ACTUATOR_FAULT = "actuator_fault"
    CLOCK_MODE_UNSUPPORTED = "clock_mode_unsupported"
    CONTRACT_DRIFT = "contract_drift"
    TWIN_DIVERGED = "twin_diverged"
    TWIN_FIDELITY_FAULT = "twin_fidelity_fault"
    CONSTRAINT_VIOLATION = "constraint_violation"
    LOW_CONFIDENCE = "low_confidence"
    BOUNDS_MISMATCH = "bounds_mismatch"
    WRITE_UNAUTHORIZED = "write_unauthorized"
    PLATFORM_UNAVAILABLE = "platform_unavailable"
    CYCLE_TIMEOUT = "cycle_timeout"
    LLM_UNAVAILABLE = "llm_unavailable"


# Raise-time class for each reason code (optimizer interfaces spec table). Used by the input
# gate and later the escalation surface to classify holds without parsing prose.
REASON_CLASS: dict[ReasonCode, ReasonClass] = {
    ReasonCode.INPUT_STALE: ReasonClass.TRANSIENT,
    ReasonCode.INPUT_INCOMPLETE: ReasonClass.TRANSIENT,
    ReasonCode.SENSOR_FAULT: ReasonClass.TRANSIENT,
    ReasonCode.ACTUATOR_FAULT: ReasonClass.TRANSIENT,
    ReasonCode.CLOCK_MODE_UNSUPPORTED: ReasonClass.TRANSIENT,
    ReasonCode.CONTRACT_DRIFT: ReasonClass.PERSISTENT,
    ReasonCode.TWIN_DIVERGED: ReasonClass.TRANSIENT,
    ReasonCode.TWIN_FIDELITY_FAULT: ReasonClass.PERSISTENT,
    ReasonCode.CONSTRAINT_VIOLATION: ReasonClass.PERSISTENT,
    ReasonCode.LOW_CONFIDENCE: ReasonClass.TRANSIENT,
    ReasonCode.BOUNDS_MISMATCH: ReasonClass.PERSISTENT,
    ReasonCode.WRITE_UNAUTHORIZED: ReasonClass.PERSISTENT,
    ReasonCode.PLATFORM_UNAVAILABLE: ReasonClass.TRANSIENT,
    ReasonCode.CYCLE_TIMEOUT: ReasonClass.TRANSIENT,
    ReasonCode.LLM_UNAVAILABLE: ReasonClass.TRANSIENT,
}
