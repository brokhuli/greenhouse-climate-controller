//! MQTT telemetry publisher ([interfaces §2, §7]).
//!
//! Publishing is **decoupled from control** (`P1-RESIL-3`): the rumqttc event loop runs on its own
//! task (driving I/O and auto-reconnect), and [`Publisher::publish_snapshot`] uses **non-blocking
//! `try_publish`** with a **bounded** outbound buffer — so a slow, blocked, or disconnected broker
//! can never stall the control tick. Under sustained backpressure frames are dropped rather than
//! accumulated; that is safe because each tick fully supersedes the last and the **retained**
//! `gh/{id}/state` snapshot always carries the latest truth, re-priming any (re)connecting
//! subscriber.

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use rumqttc::{AsyncClient, MqttOptions, QoS};

use crate::state::Snapshot;
use crate::telemetry::{FaultKey, active_fault_keys, epoch, telemetry_frames};

/// Bounded outbound request buffer. When full (broker unreachable), `try_publish` errors and the
/// frame is dropped — never queued unboundedly.
const OUTBOUND_CAP: usize = 64;

/// Wall-clock keep-alive for the broker connection (infrastructure timer; does not scale with the
/// simulation time-scale).
const KEEP_ALIVE_SECS: u64 = 5;

/// Publishes telemetry for one greenhouse to an MQTT broker.
pub struct Publisher {
    client: AsyncClient,
    greenhouse_id: String,
    base: DateTime<Utc>,
    /// Faults active as of the last publish, so a persisting fault isn't re-emitted as a new event
    /// every tick ([interfaces §2]).
    prev_faults: BTreeSet<FaultKey>,
}

impl Publisher {
    /// Connect to the broker and spawn the event-loop task (which auto-reconnects). Must be called
    /// inside a Tokio runtime.
    pub fn connect(broker_url: &str, greenhouse_id: &str) -> Self {
        let (host, port) = parse_broker_url(broker_url);
        let mut options = MqttOptions::new(format!("controller-{greenhouse_id}"), host, port);
        options.set_keep_alive(std::time::Duration::from_secs(KEEP_ALIVE_SECS));
        let (client, mut eventloop) = AsyncClient::new(options, OUTBOUND_CAP);

        // Drive the event loop on its own task: this performs the actual network I/O and reconnects
        // on failure. The control tick never touches it.
        tokio::spawn(async move {
            loop {
                if let Err(err) = eventloop.poll().await {
                    tracing::warn!("mqtt event loop error (will retry): {err}");
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        });

        Publisher {
            client,
            greenhouse_id: greenhouse_id.to_string(),
            base: epoch(),
            prev_faults: BTreeSet::new(),
        }
    }

    /// Publish all telemetry frames for a committed snapshot. Non-blocking: a frame that cannot be
    /// enqueued (broker backpressure) is dropped, never awaited. Fault events fire only on the
    /// rising edge; the set of currently-active faults is carried to the next call.
    pub fn publish_snapshot(&mut self, snapshot: &Snapshot, time_scale: f64) {
        for frame in telemetry_frames(
            snapshot,
            &self.greenhouse_id,
            self.base,
            time_scale,
            &self.prev_faults,
        ) {
            if let Err(err) =
                self.client
                    .try_publish(frame.topic, QoS::AtLeastOnce, frame.retain, frame.payload)
            {
                // Bounded-buffer drop under backpressure — expected when the broker is unreachable.
                tracing::trace!("dropping telemetry frame under backpressure: {err}");
            }
        }
        self.prev_faults = active_fault_keys(snapshot);
    }
}

/// Parse an `mqtt://host:port` (or bare `host:port` / `host`) URL into `(host, port)`, defaulting
/// the port to 1883.
fn parse_broker_url(url: &str) -> (String, u16) {
    let without_scheme = url
        .strip_prefix("mqtt://")
        .or_else(|| url.strip_prefix("tcp://"))
        .unwrap_or(url)
        .trim_end_matches('/');
    let (host, port) = match without_scheme.rsplit_once(':') {
        Some((host, port)) => (host, port.parse().unwrap_or(1883)),
        None => (without_scheme, 1883),
    };
    let host = if host.is_empty() { "localhost" } else { host };
    (host.to_string(), port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_broker_urls() {
        assert_eq!(
            parse_broker_url("mqtt://localhost:1883"),
            ("localhost".into(), 1883)
        );
        assert_eq!(
            parse_broker_url("mqtt://broker:1884"),
            ("broker".into(), 1884)
        );
        assert_eq!(parse_broker_url("host-only"), ("host-only".into(), 1883));
        assert_eq!(
            parse_broker_url("tcp://10.0.0.5:1883"),
            ("10.0.0.5".into(), 1883)
        );
    }
}
