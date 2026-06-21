//! Manual override — pipeline stage ④ ([architecture §6]).
//!
//! The REST API can force any actuator to a level, bypassing its control loop. Override sits
//! *downstream of the loops* (it replaces their output) but *upstream of safety interlocks* (so it
//! can never defeat them). Every override carries an auto-expiry so a forgotten one cannot strand
//! the greenhouse (`P1-RESIL-2`); it is also clearable explicitly. (Module is `overrides` because
//! `override` is a reserved word in Rust.)

use std::collections::BTreeMap;

use crate::clock::Clock;
use crate::hal::{ActuatorId, Commands};

/// One active override: a forced level, when it was set, and when it auto-expires.
#[derive(Debug, Clone, PartialEq)]
pub struct Override {
    /// Forced actuator level (0..=100).
    pub level: f64,
    /// Tick index at which the override was set.
    pub created_at_tick: u64,
    /// Tick index at which the override auto-clears.
    pub expires_at_tick: u64,
}

/// All active manual overrides, keyed by actuator.
#[derive(Debug, Clone, Default)]
pub struct OverrideState {
    active: BTreeMap<ActuatorId, Override>,
}

impl OverrideState {
    /// No overrides.
    pub fn new() -> Self {
        OverrideState::default()
    }

    /// Force `id` to `level` for `timeout_secs` simulated seconds from now (latched: takes effect
    /// next tick, like every other write).
    pub fn set(&mut self, id: ActuatorId, level: f64, clock: &Clock, timeout_secs: u64) {
        self.active.insert(
            id,
            Override {
                level: level.clamp(0.0, 100.0),
                created_at_tick: clock.tick_index(),
                expires_at_tick: clock.tick_index().saturating_add(timeout_secs),
            },
        );
    }

    /// Clear an override explicitly.
    pub fn clear(&mut self, id: &ActuatorId) {
        self.active.remove(id);
    }

    /// Drop any overrides whose deadline has passed (auto-expiry, `P1-RESIL-2`).
    pub fn expire(&mut self, clock: &Clock) {
        let now = clock.tick_index();
        self.active.retain(|_, ov| ov.expires_at_tick > now);
    }

    /// The active overrides (for telemetry / inspection).
    pub fn active(&self) -> &BTreeMap<ActuatorId, Override> {
        &self.active
    }

    /// Whether `id` is currently overridden.
    pub fn is_overridden(&self, id: &ActuatorId) -> bool {
        self.active.contains_key(id)
    }

    /// Replace the desired level of every overridden actuator with its forced value (stage ④).
    pub fn apply(&self, cmd: &mut Commands) {
        for (id, ov) in &self.active {
            cmd.set(id, ov.level);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Actuator;

    fn heater() -> ActuatorId {
        ActuatorId::House(Actuator::Heater)
    }

    #[test]
    fn override_replaces_loop_output() {
        let mut state = OverrideState::new();
        let clock = Clock::new();
        state.set(heater(), 100.0, &clock, 60);
        let mut cmd = Commands::all_off(&[]);
        cmd.set(&heater(), 0.0); // loop wanted off
        state.apply(&mut cmd);
        assert_eq!(cmd.get(&heater()), 100.0);
    }

    #[test]
    fn override_auto_expires() {
        let mut state = OverrideState::new();
        let mut clock = Clock::new();
        state.set(heater(), 100.0, &clock, 3); // expires at tick 3
        for _ in 0..3 {
            clock.advance();
            state.expire(&clock);
        }
        assert!(
            !state.is_overridden(&heater()),
            "override should have expired by tick 3"
        );
    }

    #[test]
    fn explicit_clear_removes_override() {
        let mut state = OverrideState::new();
        let clock = Clock::new();
        state.set(heater(), 50.0, &clock, 600);
        assert!(state.is_overridden(&heater()));
        state.clear(&heater());
        assert!(!state.is_overridden(&heater()));
    }
}
