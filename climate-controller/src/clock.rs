//! The virtual simulation clock.
//!
//! The pipeline reads time from **here**, never from the OS — every time-based decision
//! (day/night resolution, DLI accumulation, drain timers, override/injection expiry, the HAL
//! lag step) advances by a fixed step `Δt` **per tick** ([architecture §3], [HAL §7]). That is
//! what makes a seeded run reproducible: day/night flips at the same `tick_index` every time, and
//! the wall-clock `time_scale` knob (deferred to the runtime driver) changes only how often a
//! tick fires — never `Δt` — so it cannot perturb the tick-for-tick sequence.

use crate::domain::TimeOfDay;

/// The fixed simulated time step per tick, in seconds (one tick = one simulated second).
pub const DT_SECS: u64 = 1;

/// A monotonic simulated clock: a tick counter plus simulated seconds since an arbitrary
/// day-aligned epoch. Time-of-day is the seconds modulo a day.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Clock {
    tick_index: u64,
    sim_seconds: u64,
}

impl Clock {
    /// Seconds in a day.
    pub const DAY_SECS: u64 = 86_400;

    /// A clock starting at midnight (tick 0).
    pub fn new() -> Self {
        Clock::starting_at_seconds(0)
    }

    /// A clock whose first tick is at the given time-of-day — convenient for scenarios that want
    /// to start near a day/night transition without stepping thousands of ticks.
    pub fn starting_at(tod: TimeOfDay) -> Self {
        Clock::starting_at_seconds(u64::from(tod.minutes_since_midnight()) * 60)
    }

    /// A clock starting at an explicit seconds-of-day offset.
    pub fn starting_at_seconds(sim_seconds: u64) -> Self {
        Clock {
            tick_index: 0,
            sim_seconds,
        }
    }

    /// The monotonic tick counter since startup.
    pub fn tick_index(&self) -> u64 {
        self.tick_index
    }

    /// Simulated seconds since the epoch (monotonic).
    pub fn sim_seconds(&self) -> u64 {
        self.sim_seconds
    }

    /// Advance one tick (`Δt` simulated seconds).
    pub fn advance(&mut self) {
        self.tick_index += 1;
        self.sim_seconds += DT_SECS;
    }

    /// Second within the current day, `0..86_400`.
    pub fn second_of_day(&self) -> u32 {
        (self.sim_seconds % Self::DAY_SECS) as u32
    }

    /// Minute within the current day, `0..1_440`.
    pub fn minute_of_day(&self) -> u16 {
        (self.second_of_day() / 60) as u16
    }

    /// Whether the current time-of-day is within `[start, end)` (the day window).
    pub fn is_within(&self, start: TimeOfDay, end: TimeOfDay) -> bool {
        let m = self.minute_of_day();
        m >= start.minutes_since_midnight() && m < end.minutes_since_midnight()
    }
}

impl Default for Clock {
    fn default() -> Self {
        Clock::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advances_by_one_second_per_tick() {
        let mut c = Clock::new();
        assert_eq!(c.tick_index(), 0);
        assert_eq!(c.sim_seconds(), 0);
        c.advance();
        assert_eq!(c.tick_index(), 1);
        assert_eq!(c.sim_seconds(), 1);
    }

    #[test]
    fn time_of_day_wraps_at_midnight() {
        let mut c = Clock::starting_at_seconds(Clock::DAY_SECS - 1);
        assert_eq!(c.second_of_day(), 86_399);
        c.advance();
        assert_eq!(c.second_of_day(), 0);
        // tick_index keeps counting monotonically across the day boundary.
        assert_eq!(c.tick_index(), 1);
    }

    #[test]
    fn starting_at_sets_time_of_day() {
        let c = Clock::starting_at("06:00".parse().unwrap());
        assert_eq!(c.minute_of_day(), 360);
    }

    #[test]
    fn is_within_day_window() {
        let start: TimeOfDay = "06:00".parse().unwrap();
        let end: TimeOfDay = "20:00".parse().unwrap();
        assert!(Clock::starting_at("12:00".parse().unwrap()).is_within(start, end));
        assert!(!Clock::starting_at("05:59".parse().unwrap()).is_within(start, end));
        assert!(!Clock::starting_at("20:00".parse().unwrap()).is_within(start, end));
        assert!(Clock::starting_at("06:00".parse().unwrap()).is_within(start, end));
    }
}
