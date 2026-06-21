//! Actuator constraints — pipeline stage ⑥ ([safety §4]).
//!
//! Shapes the resolved command to what real hardware can do: slew/ramp **rate limits** (motors and
//! fans can't move instantly) and **min on/off / min-open dwell** (anti short-cycle). Applied last,
//! so they shape whatever produced the command — loop, override, or interlock. One safety carve-out
//! ([safety §3]): a *rate* limit still applies to an interlock move (it's a physical maximum), but
//! a *dwell* constraint is **waived** for an actuator the interlock forced toward a safe state, so
//! anti-short-cycle never delays the `P1-REL-1` one-tick safety response.

use std::collections::{BTreeMap, BTreeSet};

use crate::clock::DT_SECS;
use crate::config::{Config, Constraints};
use crate::domain::Actuator;
use crate::hal::{ActuatorId, Commands};

/// Per-actuator applied state: last level and how many ticks it has held its current on/off state.
#[derive(Debug, Clone, Default)]
struct Applied {
    level: f64,
    ticks_in_state: u64,
    initialized: bool,
}

/// Across-tick constraint state plus the per-actuator-kind constraint config.
#[derive(Debug, Clone)]
pub struct ConstraintState {
    applied: BTreeMap<ActuatorId, Applied>,
    constraints: BTreeMap<Actuator, Constraints>,
}

impl ConstraintState {
    /// Build from the config coupling matrix's per-actuator constraints.
    pub fn new(config: &Config) -> Self {
        let constraints = config
            .hal
            .actuators
            .iter()
            .map(|m| (m.actuator, m.constraints.clone()))
            .collect();
        ConstraintState {
            applied: BTreeMap::new(),
            constraints,
        }
    }

    fn constraints_for(&self, id: &ActuatorId) -> Constraints {
        let actuator = match id {
            ActuatorId::House(a) => *a,
            ActuatorId::Valve(_) => Actuator::IrrigationValve,
        };
        self.constraints.get(&actuator).cloned().unwrap_or_default()
    }

    /// Shape every command in `cmd`. Dwell is waived for actuators in `waive_dwell` (those an
    /// interlock or actuator-health disable forced toward safe).
    pub fn apply(&mut self, cmd: &mut Commands, waive_dwell: &BTreeSet<ActuatorId>) {
        for id in cmd.ids() {
            let desired = cmd.get(&id);
            let constraints = self.constraints_for(&id);
            let waive = waive_dwell.contains(&id);
            let prev = self.applied.entry(id.clone()).or_default();
            let out = shape(prev, desired, &constraints, waive);
            cmd.set(&id, out);
        }
    }
}

/// Shape one actuator's command against its constraints, updating its applied state.
fn shape(prev: &mut Applied, desired: f64, c: &Constraints, waive_dwell: bool) -> f64 {
    let dt = DT_SECS as f64;
    let mut out = desired.clamp(0.0, 100.0);

    let prev_on = prev.level > 0.0;
    let want_on = out > 0.0;

    // Dwell (anti short-cycle): waived for an interlock-forced safe move.
    if !waive_dwell && prev.initialized {
        if prev_on && !want_on {
            // Wants OFF: honor minimum on-time (or valve minimum open time).
            if let Some(min) = c.min_on_secs.or(c.min_open_secs)
                && prev.ticks_in_state < min
            {
                out = prev.level; // stay on
            }
        } else if !prev_on
            && want_on
            && let Some(min) = c.min_off_secs
            && prev.ticks_in_state < min
        {
            // Wants ON: honor minimum off-time.
            out = 0.0; // stay off
        }
    }

    // Rate limit (slew / ramp): always applies — a physical maximum, even for a safety move.
    if let Some(rate) = c.slew_pct_per_s.or(c.ramp_pct_per_s) {
        let max_step = rate * dt;
        let delta = (out - prev.level).clamp(-max_step, max_step);
        out = prev.level + delta;
    }
    out = out.clamp(0.0, 100.0);

    // Update on/off dwell counter.
    let new_on = out > 0.0;
    if prev.initialized && new_on == prev_on {
        prev.ticks_in_state += 1;
    } else {
        prev.ticks_in_state = 0;
    }
    prev.level = out;
    prev.initialized = true;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config::load(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config/greenhouse.example.toml"
        ))
        .expect("example config loads")
    }

    fn vents() -> ActuatorId {
        ActuatorId::House(Actuator::RoofVents)
    }
    fn heater() -> ActuatorId {
        ActuatorId::House(Actuator::Heater)
    }

    #[test]
    fn slew_limits_vent_movement_per_tick() {
        // Example config: roof_vents slew 5 %/s.
        let mut state = ConstraintState::new(&config());
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&vents(), 100.0);
        state.apply(&mut cmd, &BTreeSet::new());
        assert_eq!(
            cmd.get(&vents()),
            5.0,
            "first tick rises by at most the slew rate"
        );
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&vents(), 100.0);
        state.apply(&mut cmd, &BTreeSet::new());
        assert_eq!(
            cmd.get(&vents()),
            10.0,
            "second tick adds another slew step"
        );
    }

    #[test]
    fn min_on_time_keeps_heater_on() {
        // Example config: heater min_on 60 s, min_off 60 s.
        let mut state = ConstraintState::new(&config());
        // Turn on.
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&heater(), 100.0);
        state.apply(&mut cmd, &BTreeSet::new());
        assert_eq!(cmd.get(&heater()), 100.0);
        // Immediately want off — min on-time not elapsed → stays on.
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&heater(), 0.0);
        state.apply(&mut cmd, &BTreeSet::new());
        assert_eq!(cmd.get(&heater()), 100.0, "held on by min on-time");
    }

    #[test]
    fn interlock_waives_min_on_dwell() {
        let mut state = ConstraintState::new(&config());
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&heater(), 100.0);
        state.apply(&mut cmd, &BTreeSet::new()); // heater on
        // A safety move forces it off the very next tick despite min on-time.
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&heater(), 0.0);
        let mut waive = BTreeSet::new();
        waive.insert(heater());
        state.apply(&mut cmd, &waive);
        assert_eq!(
            cmd.get(&heater()),
            0.0,
            "dwell waived for an interlock-forced safe move"
        );
    }
}
