//! A tiny deterministic PRNG (SplitMix64) for the simulated HAL.
//!
//! The simulation must be reproducible under a fixed seed (`P1-TEST-2`): identical seed +
//! inputs ⇒ identical readings, tick for tick, on every platform. A hand-rolled SplitMix64 gives
//! that with a fully specified bit-mixing function and no external dependency (CLAUDE.md: no deps
//! without justification) — `std`'s `RandomState`/`HashMap` iteration and the `rand` crate are
//! both unsuitable (non-deterministic or churny). All stochastic elements (sensor noise) draw
//! from one of these, never from wall-clock or OS entropy ([HAL §7]).

/// A SplitMix64 generator. Cheap, deterministic, and good enough for sensor-noise jitter.
#[derive(Debug, Clone)]
pub struct Rng {
    state: u64,
}

impl Rng {
    /// Seed the generator. The same seed always produces the same sequence.
    pub fn new(seed: u64) -> Self {
        Rng { state: seed }
    }

    /// Next raw 64-bit value (SplitMix64).
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform `f64` in `[0, 1)` (53-bit mantissa precision).
    pub fn next_f64(&mut self) -> f64 {
        // Top 53 bits → [0, 2^53) → divide into [0, 1).
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// A standard-normal sample (mean 0, σ 1) via the Box–Muller transform.
    pub fn next_gaussian(&mut self) -> f64 {
        // Guard the log against a zero draw.
        let u1 = self.next_f64().max(f64::MIN_POSITIVE);
        let u2 = self.next_f64();
        (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_sequence() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);
        for _ in 0..1000 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn different_seeds_differ() {
        let mut a = Rng::new(1);
        let mut b = Rng::new(2);
        assert_ne!(a.next_u64(), b.next_u64());
    }

    #[test]
    fn uniform_in_unit_interval() {
        let mut r = Rng::new(7);
        for _ in 0..10_000 {
            let x = r.next_f64();
            assert!((0.0..1.0).contains(&x), "{x} out of [0,1)");
        }
    }

    #[test]
    fn gaussian_mean_is_near_zero() {
        let mut r = Rng::new(123);
        let n = 100_000;
        let mean: f64 = (0..n).map(|_| r.next_gaussian()).sum::<f64>() / n as f64;
        assert!(mean.abs() < 0.02, "mean {mean} not near 0");
    }
}
