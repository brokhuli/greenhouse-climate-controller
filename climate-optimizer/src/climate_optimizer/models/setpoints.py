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
        # Absent means "unchanged", so an *explicit* null carries no meaning and, unlike an omitted
        # field, survives ``exclude_unset`` onto the wire — where it violates the setpoint API's
        # non-null typed fields. Reject it here so the validated patch equals the submitted one.
        explicit_nulls = [field for field in self.model_fields_set if getattr(self, field) is None]
        if explicit_nulls:
            raise ValueError(
                f"SetpointsPatch fields must not be explicitly null: {', '.join(explicit_nulls)}"
            )
        return self


class SetpointAdjustments(StrictModel):
    """The model's per-cycle *adjustments* — how much to change each climate target, not new absolutes.

    Rec 1 (delta action space, spec 04): the planner returns a small signed *delta* per target, which
    :meth:`Planner._assemble` adds to the current setpoint (``target = clamp(current + delta, bounds)``).
    The per-field caps below are the load-bearing mechanism: an absolute like ``23`` is outside every
    cap, so a constrained-decoding backend *cannot* emit one — it can only say "nudge the current value
    by N", which forces it to condition on the current setpoint we hand it instead of falling back on a
    training prior. Lenient like a draft (no ``minProperties`` / no-null validators): an empty object, a
    null, or an all-zero set is a deliberate "hold", read as an extend in ``_assemble`` rather than
    rejected. **Climate scalars only** — schedule times (``day_start``/``day_end``) and irrigation zones
    are not LLM-refined; they stay on their profile/baseline values.
    """

    temperature_day_c: float | None = Field(default=None, ge=-3.0, le=3.0)
    temperature_night_c: float | None = Field(default=None, ge=-3.0, le=3.0)
    humidity_low_pct: float | None = Field(default=None, ge=-10.0, le=10.0)
    humidity_high_pct: float | None = Field(default=None, ge=-10.0, le=10.0)
    humidity_deadband_pct: float | None = Field(default=None, ge=-5.0, le=5.0)
    co2_target_ppm: int | None = Field(default=None, ge=-150, le=150)
    co2_vent_interlock_threshold_pct: float | None = Field(default=None, ge=-10.0, le=10.0)
    vpd_target_kpa: float | None = Field(default=None, ge=-0.3, le=0.3)
    dli_target_mol: float | None = Field(default=None, ge=-3.0, le=3.0)
