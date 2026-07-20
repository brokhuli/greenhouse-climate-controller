"""Setpoint bundle shapes — the full ``Setpoints`` and the partial ``SetpointsPatch``.

Mirrors ``contracts/optimizer-internal-plan-schema/setpoints.schema.json`` (and the identical
``platform-optimizer-planning-rest`` / ``optimizer-platform-setpoints-rest`` copies — one Go
DTO backs them all). Cross-field invariants the JSON Schema cannot express
(``humidity_low < humidity_high``, ``day_start < day_end``, ``moisture_low < moisture_high``)
are enforced by the constraint engine and by Phase 2 on the write path, not here.
"""

from __future__ import annotations

from pydantic import Field, model_validator

from .base import SCHEDULE_PATTERN, SLUG_PATTERN, StrictModel


class ZoneTargets(StrictModel):
    """One irrigation zone's runtime-adjustable targets, matched by ``zone_id``."""

    zone_id: str = Field(pattern=SLUG_PATTERN)
    moisture_low_threshold: float = Field(ge=0, le=1)
    moisture_high_threshold: float = Field(ge=0, le=1)
    drain_period_secs: int = Field(ge=0)
    schedule: str = Field(pattern=SCHEDULE_PATTERN)


class Setpoints(StrictModel):
    """A greenhouse's full target bundle — every field required (the resolved intended state)."""

    temperature_day_c: float = Field(ge=-20, le=60)
    temperature_night_c: float = Field(ge=-20, le=60)
    day_start: str = Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    day_end: str = Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    humidity_low_pct: float = Field(ge=0, le=100)
    humidity_high_pct: float = Field(ge=0, le=100)
    humidity_deadband_pct: float = Field(ge=0, le=50)
    co2_target_ppm: int = Field(ge=0, le=5000)
    co2_vent_interlock_threshold_pct: float = Field(ge=0, le=100)
    vpd_target_kpa: float = Field(ge=0)
    dli_target_mol: float = Field(ge=0)
    zones: list[ZoneTargets]


class SetpointsPatch(StrictModel):
    """A partial (merge) update — any non-empty subset of ``Setpoints`` fields, same bounds.

    Absent fields are unchanged; a present ``zones`` array updates the named zones (each must
    specify its full target set), matched by ``zone_id``. This is the refined-targets shape the
    optimizer proposes as ``immediate_setpoints`` and on every trajectory point.
    """

    temperature_day_c: float | None = Field(default=None, ge=-20, le=60)
    temperature_night_c: float | None = Field(default=None, ge=-20, le=60)
    day_start: str | None = Field(default=None, pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    day_end: str | None = Field(default=None, pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    humidity_low_pct: float | None = Field(default=None, ge=0, le=100)
    humidity_high_pct: float | None = Field(default=None, ge=0, le=100)
    humidity_deadband_pct: float | None = Field(default=None, ge=0, le=50)
    co2_target_ppm: int | None = Field(default=None, ge=0, le=5000)
    co2_vent_interlock_threshold_pct: float | None = Field(default=None, ge=0, le=100)
    vpd_target_kpa: float | None = Field(default=None, ge=0)
    dli_target_mol: float | None = Field(default=None, ge=0)
    zones: list[ZoneTargets] | None = None

    @model_validator(mode="after")
    def _at_least_one_field(self) -> SetpointsPatch:
        # Mirrors the schema's ``minProperties: 1`` — an empty patch is meaningless.
        if not self.model_fields_set:
            raise ValueError("SetpointsPatch must set at least one field")
        return self
