//! Runtime resilience ([verification §4], `P1-RESIL-3`).
//!
//! Telemetry is the only window into a headless controller, but it must never become a way to
//! *stop* one: publishing is decoupled from control via a non-blocking, bounded publisher. This
//! asserts that running the pipeline and publishing every tick **with no broker reachable** stays
//! fast — a disconnected broker is a data gap, not a control failure.

use std::time::{Duration, Instant};

use climate_controller::config::Config;
use climate_controller::hal::SimulatedHal;
use climate_controller::mqtt::Publisher;
use climate_controller::pipeline::Pipeline;

#[tokio::test]
async fn publishing_never_blocks_the_tick_when_broker_is_down() {
    let cfg = Config::load(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/config/greenhouse.example.toml"
    ))
    .unwrap();
    let hal = SimulatedHal::new(&cfg);
    let mut pipeline = Pipeline::new(cfg, hal);

    // Nothing is listening on port 1 — the publisher's event loop retries on its own task while the
    // control loop keeps ticking and publishing through the bounded, non-blocking buffer.
    let publisher = Publisher::connect("mqtt://127.0.0.1:1", "gh-a");

    let start = Instant::now();
    for _ in 0..300 {
        let snapshot = pipeline.tick();
        publisher.publish_snapshot(&snapshot, 1.0);
    }
    let elapsed = start.elapsed();

    assert!(
        elapsed < Duration::from_secs(2),
        "300 ticks + publishes against a dead broker took {elapsed:?}; \
         publishing must never block the control tick (P1-RESIL-3)"
    );
}
