"""Digital twin (spec 03) — the deterministic forward climate model and its bundled parameters.

Re-exports the public surface of :mod:`.model` (the forward simulation) and :mod:`.params` (the
HAL-seeded twin parameters) so callers import both from one place: ``from ...domain.twin import ...``.
"""

from __future__ import annotations

from .model import (
    PredictedPoint,
    TwinResult,
    TwinState,
    fidelity_residual,
    projected_remaining_dli,
    rh_target_from_vpd,
    saturation_vapor_pressure_kpa,
    second_of_day,
    seed_state_from_context,
    simulate,
    solar_fraction,
    vapor_pressure_deficit_kpa,
)
from .params import (
    HOUSE_ACTUATORS,
    TwinParams,
    default_twin_params,
)

__all__ = [
    "HOUSE_ACTUATORS",
    "PredictedPoint",
    "TwinParams",
    "TwinResult",
    "TwinState",
    "default_twin_params",
    "fidelity_residual",
    "projected_remaining_dli",
    "rh_target_from_vpd",
    "saturation_vapor_pressure_kpa",
    "second_of_day",
    "seed_state_from_context",
    "simulate",
    "solar_fraction",
    "vapor_pressure_deficit_kpa",
]
