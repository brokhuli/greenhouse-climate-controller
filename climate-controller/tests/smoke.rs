//! Smoke test — wires the `cargo test` integration harness.
//!
//! Placeholder to be replaced by real per-module integration tests as the controller
//! is implemented (sensor fusion, control loops, interlocks, …) following the TDD
//! approach for Phase 1.

#[test]
fn integration_harness_is_wired() {
    let sum: u32 = (1..=3).sum();
    assert_eq!(sum, 6);
}
