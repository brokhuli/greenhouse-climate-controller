//! CO₂ on/off loop with the vent interlock ([control-loops "CO₂ on/off with vent interlock"]).
//!
//! The injector opens below `co2_target_ppm` and closes once reached. A **hard interlock** keeps
//! it off whenever roof-vent position exceeds `co2_vent_interlock_threshold_pct` — enriching while
//! venting wastes CO₂. This is a loop-level optimization (distinct from the crop-protection
//! [safety interlocks](crate::safety)). Stateless: the decision is a pure function of this tick's
//! trusted CO₂ and the temperature loop's already-computed vent position. A faulted CO₂ sensor
//! fails the injector closed (never enrich blind).

use crate::domain::Actuator;
use crate::hal::{ActuatorId, Commands};
use crate::sensing::TrustedState;

use super::ResolvedSetpoints;

/// Compute the desired CO₂-injector level and write it into `cmd`. Must run **after** the
/// temperature loop has set the roof-vent position (the vent interlock reads it).
pub fn run(trusted: &TrustedState, resolved: &ResolvedSetpoints, cmd: &mut Commands) {
    let vents = cmd.get(&ActuatorId::House(Actuator::RoofVents));
    let injector = match trusted.co2 {
        // Fail-closed: no trusted CO₂ reading → never enrich.
        None => 0.0,
        Some(_) if vents > resolved.vent_interlock_threshold_pct => 0.0,
        Some(co2) if co2 < resolved.co2_target_ppm => 100.0,
        Some(_) => 0.0,
    };
    cmd.set(&ActuatorId::House(Actuator::Co2Injector), injector);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved() -> ResolvedSetpoints {
        ResolvedSetpoints {
            temperature_c: 24.0,
            humidity_target_pct: Some(60.0),
            humidity_low_pct: 50.0,
            humidity_high_pct: 85.0,
            humidity_deadband_pct: 5.0,
            co2_target_ppm: 1000.0,
            vent_interlock_threshold_pct: 15.0,
            dli_target_mol: 20.0,
        }
    }

    fn trusted(co2: Option<f64>) -> TrustedState {
        TrustedState {
            temperature: Some(24.0),
            humidity: Some(60.0),
            co2,
            par: Some(300.0),
            vpd: Some(1.0),
            soil_moisture: Default::default(),
        }
    }

    fn injector(cmd: &Commands) -> f64 {
        cmd.get(&ActuatorId::House(Actuator::Co2Injector))
    }

    #[test]
    fn low_co2_opens_injector() {
        let mut cmd = Commands::all_off(&[]);
        run(&trusted(Some(600.0)), &resolved(), &mut cmd);
        assert_eq!(injector(&cmd), 100.0);
    }

    #[test]
    fn at_target_closes_injector() {
        let mut cmd = Commands::all_off(&[]);
        run(&trusted(Some(1000.0)), &resolved(), &mut cmd);
        assert_eq!(injector(&cmd), 0.0);
    }

    #[test]
    fn open_vents_hard_interlock_the_injector() {
        let mut cmd = Commands::all_off(&[]);
        // Vents wide open above the threshold: injector must stay off even though CO₂ is low.
        cmd.set(&ActuatorId::House(Actuator::RoofVents), 50.0);
        run(&trusted(Some(400.0)), &resolved(), &mut cmd);
        assert_eq!(injector(&cmd), 0.0, "no enrichment while venting");
    }

    #[test]
    fn co2_fault_fails_closed() {
        let mut cmd = Commands::all_off(&[]);
        run(&trusted(None), &resolved(), &mut cmd);
        assert_eq!(injector(&cmd), 0.0);
    }
}
