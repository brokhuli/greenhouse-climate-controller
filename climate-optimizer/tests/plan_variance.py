"""Spec-08 §3 plan-variance baselines — the per-backend regression-baseline harness.

Because the LLM is stochastic even at temperature 0 (spec 04 determinism), plan regression is a
**bounded** comparison, not an exact match: a re-run of a scenario must land within a tolerance band
of the recorded baseline plan. A baseline is keyed by ``(provider, model, prompt_version, sampling)``
and stored **per backend**, since each allowlisted local model, cloud model, or fallback produces its
own distribution and is held to its own baseline (spec 08 §3).

Capturing a baseline is a deliberate **offline** act — a provider/``prompt_version`` change or adding a
model to the allowlist, never a runtime model switch (see ``tests/baselines/README.md``). This module
is the storage + comparison the CI regression check runs against a committed baseline; ``save_baseline``
is the capture side, invoked offline against a live backend, not in CI.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from climate_optimizer import schema_validation
from climate_optimizer.config import Settings
from climate_optimizer.models import OptimizerPlan, Provider

BASELINES_DIR = Path(__file__).resolve().parent / "baselines"

# Native-unit absolute tolerance per setpoint field — the fields live on very different scales
# (°C vs. ppm vs. kPa), so a single band would be meaningless. Anything unlisted uses ``default_abs``.
_DEFAULT_FIELD_ABS: dict[str, float] = {
    "temperature_day_c": 1.0,
    "temperature_night_c": 1.0,
    "humidity_low_pct": 5.0,
    "humidity_high_pct": 5.0,
    "humidity_deadband_pct": 2.0,
    "co2_target_ppm": 100.0,
    "co2_vent_interlock_threshold_pct": 5.0,
    "vpd_target_kpa": 0.15,
    "dli_target_mol": 2.0,
    "moisture_low_threshold": 0.05,
    "moisture_high_threshold": 0.05,
    "drain_period_secs": 60.0,
}

_NUMERIC_FIELDS = (
    "temperature_day_c",
    "temperature_night_c",
    "humidity_low_pct",
    "humidity_high_pct",
    "humidity_deadband_pct",
    "co2_target_ppm",
    "co2_vent_interlock_threshold_pct",
    "vpd_target_kpa",
    "dli_target_mol",
)
_STRING_FIELDS = ("day_start", "day_end")
_ZONE_NUMERIC_FIELDS = ("moisture_low_threshold", "moisture_high_threshold", "drain_period_secs")


def sampling_descriptor(temperature: float, top_p: float) -> str:
    """Canonical sampling tag for a backend key, e.g. ``t0-p1`` for greedy decoding."""
    return f"t{temperature:g}-p{top_p:g}"


@dataclass(frozen=True)
class BackendKey:
    """The ``(provider, model, prompt_version, sampling)`` identity a baseline is stored under."""

    provider: Provider
    model: str
    prompt_version: str
    sampling: str

    @property
    def slug(self) -> str:
        """Filesystem-safe key (``ollama__llama3.2__v1__t0-p1``)."""
        model = self.model.replace(":", "-").replace("/", "-")
        return f"{self.provider.value}__{model}__{self.prompt_version}__{self.sampling}"

    @classmethod
    def from_settings(
        cls, settings: Settings, *, model: str, sampling: str | None = None
    ) -> BackendKey:
        """Build the key for the active backend — the runtime ``model`` under the configured provider."""
        return cls(
            provider=settings.llm.provider,
            model=model,
            prompt_version=settings.llm.prompt_version,
            sampling=sampling or sampling_descriptor(settings.llm.temperature, settings.llm.top_p),
        )


@dataclass(frozen=True)
class VarianceTolerance:
    """The per-field absolute bands a re-run may deviate from its baseline within."""

    confidence_abs: float = 0.1
    trajectory_len_abs: int = 0
    default_abs: float = 1.0
    field_abs: Mapping[str, float] = field(default_factory=lambda: dict(_DEFAULT_FIELD_ABS))

    def abs_for(self, name: str) -> float:
        return self.field_abs.get(name, self.default_abs)


DEFAULT_TOLERANCE = VarianceTolerance()


@dataclass(frozen=True)
class FieldDeviation:
    """One field's baseline-vs-candidate comparison."""

    name: str
    baseline: float | int | str | None
    candidate: float | int | str | None
    delta: float | None  # None ⇒ a structural mismatch (field/zone present on only one side)
    allowed: float | None
    within: bool


@dataclass(frozen=True)
class VarianceReport:
    """The result of comparing a candidate plan to a baseline."""

    within_band: bool
    deviations: list[FieldDeviation]

    def failures(self) -> list[FieldDeviation]:
        return [d for d in self.deviations if not d.within]

    def summary(self) -> str:
        if self.within_band:
            return "within band"
        parts = [
            f"{d.name}: baseline={d.baseline} candidate={d.candidate} "
            f"(delta={d.delta}, allowed={d.allowed})"
            for d in self.failures()
        ]
        return "out of band — " + "; ".join(parts)


def _numeric_deviation(name: str, baseline: Any, candidate: Any, allowed: float) -> FieldDeviation:
    if baseline is None or candidate is None:
        # Present on only one side — a structural mismatch, never within band.
        return FieldDeviation(name, baseline, candidate, delta=None, allowed=allowed, within=False)
    delta = abs(float(candidate) - float(baseline))
    return FieldDeviation(
        name, baseline, candidate, delta=delta, allowed=allowed, within=delta <= allowed
    )


def _string_deviation(name: str, baseline: Any, candidate: Any) -> FieldDeviation:
    within = baseline == candidate
    return FieldDeviation(name, baseline, candidate, delta=None, allowed=None, within=within)


def _zones_by_id(zones: Any) -> dict[str, dict[str, Any]]:
    if not zones:
        return {}
    return {zone["zone_id"]: zone for zone in zones}


def _zone_deviations(
    baseline_zones: Any, candidate_zones: Any, tol: VarianceTolerance
) -> list[FieldDeviation]:
    base = _zones_by_id(baseline_zones)
    cand = _zones_by_id(candidate_zones)
    deviations: list[FieldDeviation] = []
    for zone_id in sorted(base.keys() | cand.keys()):
        b_zone = base.get(zone_id)
        c_zone = cand.get(zone_id)
        if b_zone is None or c_zone is None:
            deviations.append(
                FieldDeviation(
                    f"zones[{zone_id}]",
                    "present" if b_zone else None,
                    "present" if c_zone else None,
                    delta=None,
                    allowed=None,
                    within=False,
                )
            )
            continue
        for name in _ZONE_NUMERIC_FIELDS:
            deviations.append(
                _numeric_deviation(
                    f"zones[{zone_id}].{name}",
                    b_zone.get(name),
                    c_zone.get(name),
                    tol.abs_for(name),
                )
            )
        deviations.append(
            _string_deviation(
                f"zones[{zone_id}].schedule", b_zone.get("schedule"), c_zone.get("schedule")
            )
        )
    return deviations


def compare_plan_to_baseline(
    candidate: OptimizerPlan, baseline: OptimizerPlan, tol: VarianceTolerance = DEFAULT_TOLERANCE
) -> VarianceReport:
    """Compare a candidate plan to its baseline within ``tol`` — bounded, not exact (spec 08 §3)."""
    deviations: list[FieldDeviation] = [
        _numeric_deviation(
            "confidence", baseline.confidence, candidate.confidence, tol.confidence_abs
        )
    ]

    base = baseline.immediate_setpoints.model_dump(exclude_none=True)
    cand = candidate.immediate_setpoints.model_dump(exclude_none=True)
    for name in _NUMERIC_FIELDS:
        if name in base or name in cand:
            deviations.append(
                _numeric_deviation(name, base.get(name), cand.get(name), tol.abs_for(name))
            )
    for name in _STRING_FIELDS:
        if name in base or name in cand:
            deviations.append(_string_deviation(name, base.get(name), cand.get(name)))
    deviations.extend(_zone_deviations(base.get("zones"), cand.get("zones"), tol))

    deviations.append(
        _numeric_deviation(
            "trajectory_length",
            len(baseline.trajectory),
            len(candidate.trajectory),
            tol.trajectory_len_abs,
        )
    )

    return VarianceReport(within_band=all(d.within for d in deviations), deviations=deviations)


def baseline_path(key: BackendKey, scenario_id: str) -> Path:
    return BASELINES_DIR / key.slug / f"{scenario_id}.json"


def load_baseline(key: BackendKey, scenario_id: str) -> OptimizerPlan:
    """Load a committed baseline plan, asserting it is itself contract-valid."""
    raw = json.loads(baseline_path(key, scenario_id).read_text(encoding="utf-8"))
    schema_validation.validate_optimizer_plan(raw)
    return OptimizerPlan.model_validate(raw)


def save_baseline(plan: OptimizerPlan, key: BackendKey, scenario_id: str) -> Path:
    """Persist a captured baseline (offline capture side — not exercised in CI)."""
    payload = plan.model_dump(mode="json", exclude_none=True)
    schema_validation.validate_optimizer_plan(payload)
    path = baseline_path(key, scenario_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path
