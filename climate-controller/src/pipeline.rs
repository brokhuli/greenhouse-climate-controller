//! The fixed-tick pipeline ([architecture §2]).
//!
//! Each tick runs to completion through the stages — ① fuse + fault-detect, ② resolve setpoints,
//! ③ control loops, ④ manual override, ⑤ safety interlocks, ⑥ actuator constraints — then drives
//! the HAL and returns a committed [`Snapshot`]. The result is a pure function of (sensor readings,
//! controller state); the only cross-tick comparison is the actuator-health readback ([safety §5]).
//! The ordering *is* the safety guarantee: each back-half stage can only tighten toward safety.

use crate::clock::Clock;
use crate::config::Config;
use crate::control::{self, ControlState};
use crate::faults::Mode;
use crate::hal::{Commands, Hal};
use crate::overrides::OverrideState;
use crate::safety::{ConstraintState, HealthState, InterlockState};
use crate::sensing::SensingState;
use crate::state::Snapshot;

/// The controller pipeline over a [`Hal`] backend. Owns all across-tick state.
pub struct Pipeline<H: Hal> {
    config: Config,
    hal: H,
    clock: Clock,
    sensing: SensingState,
    control: ControlState,
    overrides: OverrideState,
    interlocks: InterlockState,
    constraints: ConstraintState,
    health: HealthState,
    prev_commanded: Option<Commands>,
}

impl<H: Hal> Pipeline<H> {
    /// Build a pipeline for a validated config and a HAL backend. The clock starts at midnight; use
    /// [`Pipeline::with_clock`] to start near a day/night transition.
    pub fn new(config: Config, hal: H) -> Self {
        Pipeline::with_clock(config, hal, Clock::new())
    }

    /// Build a pipeline with an explicit starting clock.
    pub fn with_clock(config: Config, hal: H, clock: Clock) -> Self {
        let zone_ids: Vec<_> = config.zones.iter().map(|z| z.id.clone()).collect();
        let sensing = SensingState::new(&zone_ids);
        let control = ControlState::new(&config);
        let constraints = ConstraintState::new(&config);
        Pipeline {
            config,
            hal,
            clock,
            sensing,
            control,
            overrides: OverrideState::new(),
            interlocks: InterlockState::new(),
            constraints,
            health: HealthState::new(),
            prev_commanded: None,
        }
    }

    /// Run one tick and return its committed snapshot.
    pub fn tick(&mut self) -> Snapshot {
        // Stage ① inputs: raw readings + the observed actuator readback (reflecting last tick's
        // command, before this tick's HAL step).
        let raw = self.hal.read();
        let observed_before = self.hal.observed();

        let mut faults = Vec::new();

        // ① fuse + fault-detect (sensor side), then actuator-health (output side).
        let trusted = self
            .sensing
            .condition(&raw, &self.config.sensing, &mut faults);
        self.health.monitor(
            self.prev_commanded.as_ref(),
            &observed_before,
            &trusted,
            &self.config,
            &mut faults,
        );

        // ② resolve the active setpoints for this tick.
        let resolved = control::resolve(&self.config.setpoints, &self.clock, trusted.temperature);

        // ③ control loops → desired actuator levels.
        let mut cmd = self
            .control
            .run(&trusted, &resolved, &self.config, &self.clock, &mut faults);

        // ④ manual override replaces the loops' output (auto-expiring first).
        self.overrides.expire(&self.clock);
        self.overrides.apply(&mut cmd);

        // ⑤ safety interlocks override everything above (unconditional).
        let mut forced =
            self.interlocks
                .apply(&trusted, &self.config, &self.clock, &mut cmd, &mut faults);

        // Actuator-health disables: force the actuator off, waiving dwell like an interlock move.
        for id in self.health.disabled() {
            cmd.set(id, 0.0);
            forced.insert(id.clone());
        }

        // ⑥ actuator constraints shape the surviving command (slew/ramp always; dwell unless forced).
        self.constraints.apply(&mut cmd, &forced);

        // Drive the HAL and advance the simulated plant.
        self.hal.command(&cmd);
        self.hal.step(&self.clock);
        let observed_after = self.hal.observed();

        let mode = Mode::from_faults(&faults);
        let snapshot = Snapshot {
            tick_index: self.clock.tick_index(),
            trusted,
            resolved,
            commanded: cmd.clone(),
            observed: observed_after,
            overrides: self.overrides.active().clone(),
            faults,
            mode,
        };

        self.prev_commanded = Some(cmd);
        self.clock.advance();
        snapshot
    }

    /// The current clock (read-only).
    pub fn clock(&self) -> &Clock {
        &self.clock
    }

    /// The config (read-only).
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Mutable access to manual overrides (the REST surface will drive this in the next slice; tests
    /// and the standalone driver use it directly).
    pub fn overrides_mut(&mut self) -> &mut OverrideState {
        &mut self.overrides
    }

    /// Mutable access to the HAL backend — used by scenarios to drive sim-only injection
    /// ([`SimControl`](crate::hal::SimControl)).
    pub fn hal_mut(&mut self) -> &mut H {
        &mut self.hal
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::hal::SimulatedHal;

    fn config() -> Config {
        Config::load(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config/greenhouse.example.toml"
        ))
        .expect("example config loads")
    }

    fn pipeline() -> Pipeline<SimulatedHal> {
        let cfg = config();
        let hal = SimulatedHal::new(&cfg);
        Pipeline::new(cfg, hal)
    }

    #[test]
    fn ticks_advance_and_stay_healthy_nominally() {
        let mut p = pipeline();
        let mut last = None;
        for i in 0..50 {
            let snap = p.tick();
            assert_eq!(snap.tick_index, i);
            last = Some(snap);
        }
        let snap = last.unwrap();
        // No injected faults → nominal operation.
        assert!(snap.healthy(), "unexpected faults: {:?}", snap.faults);
        assert_eq!(snap.mode, Mode::Normal);
    }

    #[test]
    fn determinism_identical_actuator_trajectory() {
        // P1-TEST-2: same seed + inputs ⇒ identical actuator trajectory.
        let mut a = pipeline();
        let mut b = pipeline();
        for _ in 0..200 {
            let sa = a.tick();
            let sb = b.tick();
            assert_eq!(sa.commanded, sb.commanded);
            assert_eq!(sa.observed, sb.observed);
        }
    }
}
