"""Bundled digital-twin parameters (spec 03 §1.5) — seeded from the controller HAL defaults.

The twin is the controller's coupled first-order-lag model lifted into NumPy, so its coupling
gains, time constants, disturbances, and solar curve are copied **verbatim** from the committed
HAL defaults in ``climate-controller/config/greenhouse.example.toml`` (controller HAL spec §2/§3/§5).
These ship with the optimizer; per-greenhouse calibration is out of scope (spec 13).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from numpy.typing import NDArray

# House-level actuators, in the fixed column order of the coupling matrix. The per-zone
# irrigation valve is modeled separately (asymmetric fill/dry with a residual floor).
HOUSE_ACTUATORS: tuple[str, ...] = (
    "heater",
    "fans",
    "roof_vents",
    "misters",
    "co2_injector",
    "grow_lights",
    "shade_screen",
)

# Climate state rows, in the fixed row order of the coupling matrix and the τ / envelope vectors.
CLIMATE_VARS: tuple[str, ...] = ("temperature", "humidity", "co2", "par")


def _seconds_of_day(hhmm: str) -> int:
    hours, minutes = hhmm.split(":")
    return int(hours) * 3600 + int(minutes) * 60


@dataclass(frozen=True)
class TwinParams:
    """The twin's static physics parameters (HAL-derived defaults)."""

    # Coupling gains: rows = CLIMATE_VARS, cols = HOUSE_ACTUATORS; full-on contribution to each
    # variable's target (variable's own units), scaled by level/100 at runtime.
    gains: NDArray[np.float64]
    # First-order-lag time constants (seconds), one per CLIMATE_VARS entry.
    tau_seconds: NDArray[np.float64]
    # Plausibility envelopes (min, max) per CLIMATE_VARS entry.
    env_min: NDArray[np.float64]
    env_max: NDArray[np.float64]
    # Ambient / disturbance constants (HAL §5).
    outdoor_temp_c: float
    ambient_humidity_pct: float
    ambient_co2_ppm: float
    heat_loss_coeff: float
    plant_co2_uptake_ppm_per_s: float
    # Soil (per zone).
    soil_tau_seconds: float
    soil_drying_rate_per_s: float
    soil_residual_vwc: float
    soil_env_min: float
    soil_env_max: float
    # Solar day-cycle (HAL simulation.solar).
    sunrise_sod: int
    sunset_sod: int
    peak_par: float
    peak_heat_gain_c: float
    # The one tuned twin default — the reduced controller's proportional gain (spec 03 §1.3),
    # deliberately NOT the Phase 1 PID kp; sized so a few °C of error saturates the actuator.
    controller_kp: float = 25.0

    # Convenience column indices into the gains matrix / level vector.
    _idx: dict[str, int] = field(default_factory=dict)

    def actuator_index(self, name: str) -> int:
        return self._idx[name]


def default_twin_params() -> TwinParams:
    """The committed HAL defaults (greenhouse.example.toml), as the twin's bundled parameters."""
    gains = np.array(
        # heater  fans  roof_vents misters co2_inj grow_lights shade
        [
            [22.0, -10.0, -12.0, -3.0, 0.0, 2.0, -4.0],  # temperature
            [0.0, -20.0, -30.0, 40.0, 0.0, 0.0, 0.0],  # humidity
            [0.0, -200.0, -300.0, 0.0, 1200.0, 0.0, 0.0],  # co2
            [0.0, 0.0, 0.0, 0.0, 0.0, 600.0, -900.0],  # par
        ],
        dtype=np.float64,
    )
    return TwinParams(
        gains=gains,
        tau_seconds=np.array([120.0, 60.0, 30.0, 10.0], dtype=np.float64),
        env_min=np.array([-50.0, 0.0, 0.0, 0.0], dtype=np.float64),
        env_max=np.array([90.0, 100.0, 20000.0, 5000.0], dtype=np.float64),
        outdoor_temp_c=10.0,
        ambient_humidity_pct=50.0,
        ambient_co2_ppm=420.0,
        heat_loss_coeff=0.002,
        plant_co2_uptake_ppm_per_s=0.5,
        soil_tau_seconds=1800.0,
        soil_drying_rate_per_s=0.00002,
        soil_residual_vwc=0.15,
        soil_env_min=0.0,
        soil_env_max=1.0,
        sunrise_sod=_seconds_of_day("06:00"),
        sunset_sod=_seconds_of_day("20:00"),
        peak_par=800.0,
        peak_heat_gain_c=6.0,
        _idx={name: i for i, name in enumerate(HOUSE_ACTUATORS)},
    )
