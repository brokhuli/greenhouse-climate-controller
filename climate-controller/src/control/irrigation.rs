//! Per-zone irrigation scheduler ([control-loops "Irrigation scheduler"]).
//!
//! One independent instance per [zone](crate::config::Zone). A cycle starts only when **both**
//! conditions hold: a time-of-day `schedule` trigger fires **and** soil moisture is below
//! `moisture_low_threshold`. It irrigates until `moisture_high_threshold`, then a
//! `drain_period_secs` gap must elapse before another cycle (prevents root saturation). Zones are
//! independent — a fault or cycle in one never blocks another. A faulted soil sensor fails the
//! valve closed (never water blind).

use crate::clock::Clock;
use crate::config::Zone;
use crate::domain::Slug;
use crate::hal::{ActuatorId, Commands};

/// One zone's scheduler state.
#[derive(Debug, Clone)]
pub struct IrrigationLoop {
    zone_id: Slug,
    irrigating: bool,
    last_cycle_end_tick: Option<u64>,
}

impl IrrigationLoop {
    /// Build a scheduler for a zone.
    pub fn new(zone_id: Slug) -> Self {
        IrrigationLoop {
            zone_id,
            irrigating: false,
            last_cycle_end_tick: None,
        }
    }

    /// Whether the zone's valve is currently in an irrigation cycle.
    pub fn is_irrigating(&self) -> bool {
        self.irrigating
    }

    /// The tick the most recent cycle ended, if any (for `ZoneStatus.last_cycle_ts`).
    pub fn last_cycle_end_tick(&self) -> Option<u64> {
        self.last_cycle_end_tick
    }

    /// Compute the desired valve level for this zone and write it into `cmd`.
    pub fn run(&mut self, zone: &Zone, soil: Option<f64>, clock: &Clock, cmd: &mut Commands) {
        let level = self.compute(zone, soil, clock);
        cmd.set(&ActuatorId::Valve(self.zone_id.clone()), level);
    }

    fn compute(&mut self, zone: &Zone, soil: Option<f64>, clock: &Clock) -> f64 {
        let soil = match soil {
            Some(s) => s,
            None => {
                // No trusted soil reading: fail closed (never water blind).
                self.irrigating = false;
                return 0.0;
            }
        };

        if self.irrigating {
            if soil >= zone.moisture_high_threshold {
                self.irrigating = false;
                self.last_cycle_end_tick = Some(clock.tick_index());
                return 0.0;
            }
            return 100.0;
        }

        // Idle: respect the drain gap since the last cycle ended.
        if let Some(end) = self.last_cycle_end_tick
            && clock.tick_index().saturating_sub(end) < zone.drain_period_secs
        {
            return 0.0;
        }

        // Start a cycle only on a scheduled trigger AND dry soil.
        if self.scheduled_now(zone, clock) && soil < zone.moisture_low_threshold {
            self.irrigating = true;
            return 100.0;
        }
        0.0
    }

    /// Whether a `schedule` trigger fires at the current simulated second.
    fn scheduled_now(&self, zone: &Zone, clock: &Clock) -> bool {
        let now = clock.second_of_day();
        zone.schedule
            .times()
            .iter()
            .any(|t| u32::from(t.minutes_since_midnight()) * 60 == now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zone() -> Zone {
        // schedule 06:00; irrigate from <0.35 to >=0.55; 300 s drain gap.
        toml::from_str(
            r#"
id = "bench-a"
moisture_low_threshold = 0.35
moisture_high_threshold = 0.55
drain_period_secs = 300
schedule = "06:00"
"#,
        )
        .unwrap()
    }

    fn valve(cmd: &Commands, z: &Slug) -> f64 {
        cmd.get(&ActuatorId::Valve(z.clone()))
    }

    #[test]
    fn triggers_at_schedule_when_dry_then_runs_to_high() {
        let z = zone();
        let mut loop_ = IrrigationLoop::new(z.id.clone());
        let mut cmd = Commands::all_off(std::slice::from_ref(&z.id));

        // 05:59:59 — scheduled minute not reached: stays off even though dry.
        let before = Clock::starting_at_seconds(6 * 3600 - 1);
        loop_.run(&z, Some(0.20), &before, &mut cmd);
        assert_eq!(valve(&cmd, &z.id), 0.0);

        // 06:00:00 exactly, dry → starts.
        let at = Clock::starting_at_seconds(6 * 3600);
        loop_.run(&z, Some(0.20), &at, &mut cmd);
        assert_eq!(valve(&cmd, &z.id), 100.0);

        // Keeps running below the high threshold...
        loop_.run(&z, Some(0.50), &at, &mut cmd);
        assert_eq!(valve(&cmd, &z.id), 100.0);
        // ...and stops at/above it.
        loop_.run(&z, Some(0.56), &at, &mut cmd);
        assert_eq!(valve(&cmd, &z.id), 0.0);
    }

    #[test]
    fn does_not_trigger_off_schedule_even_if_dry() {
        let z = zone();
        let mut loop_ = IrrigationLoop::new(z.id.clone());
        let mut cmd = Commands::all_off(std::slice::from_ref(&z.id));
        let noon = Clock::starting_at_seconds(12 * 3600);
        loop_.run(&z, Some(0.10), &noon, &mut cmd);
        assert_eq!(valve(&cmd, &z.id), 0.0);
    }

    #[test]
    fn soil_fault_fails_closed() {
        let z = zone();
        let mut loop_ = IrrigationLoop::new(z.id.clone());
        let mut cmd = Commands::all_off(std::slice::from_ref(&z.id));
        let at = Clock::starting_at_seconds(6 * 3600);
        loop_.run(&z, Some(0.20), &at, &mut cmd); // running
        loop_.run(&z, None, &at, &mut cmd); // sensor lost
        assert_eq!(valve(&cmd, &z.id), 0.0);
    }
}
