// Package ws is the platform→SPA live channel: the frame DTOs (platform-dashboard-live-ws contract)
// and the fan-out hub that broadcasts them to every connected dashboard client.
package ws

import (
	"time"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// SchemaVersion is the platform-dashboard-live-ws frame schema major version (RFC-007 envelope).
const SchemaVersion = 1

// rfc3339ms formats a timestamp as RFC 3339 UTC with millisecond precision, matching
// the contract envelope (e.g. 2026-06-17T14:03:00.000Z).
func rfc3339ms(ts time.Time) string {
	return ts.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// envelope is the shared frame envelope every frame embeds (RFC-007 §3).
type envelope struct {
	SchemaVersion int     `json:"schema_version"`
	GreenhouseID  string  `json:"greenhouse_id"`
	ZoneID        *string `json:"zone_id"`
	TS            string  `json:"ts"`
}

// FrameReading is one metric sample in a telemetry frame.
type FrameReading struct {
	Metric string  `json:"metric"`
	Value  float64 `json:"value"`
	Unit   string  `json:"unit"`
}

// FrameActuator is one actuator sample in a telemetry frame (0–100 position).
type FrameActuator struct {
	Actuator  string   `json:"actuator"`
	Commanded float64  `json:"commanded"`
	Observed  *float64 `json:"observed"`
}

// TelemetryFrame is a live telemetry snapshot (type="telemetry").
type TelemetryFrame struct {
	envelope
	Type      string          `json:"type"`
	Readings  []FrameReading  `json:"readings"`
	Actuators []FrameActuator `json:"actuators,omitempty"`
}

// StatusFrame is a connectivity / time-scale change (type="status").
type StatusFrame struct {
	envelope
	Type      string              `json:"type"`
	Status    domain.Connectivity `json:"status"`
	TimeScale *float64            `json:"time_scale,omitempty"`
}

// EventFrame is an activity-feed event (type="event").
type EventFrame struct {
	envelope
	Type     string `json:"type"`
	Kind     string `json:"kind"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	Source   string `json:"source,omitempty"`
}

// DriftFrame reports whether a greenhouse's controller-reported setpoints still match its
// intended state (type="drift", greenhouse-scoped): drift=true on divergence, false when
// reconciled (platform-dashboard-live-ws drift.schema.json, 2b).
type DriftFrame struct {
	envelope
	Type  string `json:"type"`
	Drift bool   `json:"drift"`
}

// NewTelemetryReading builds a telemetry frame carrying a single sensor reading.
func NewTelemetryReading(reading domain.Reading) TelemetryFrame {
	return TelemetryFrame{
		envelope: envelope{SchemaVersion, reading.GreenhouseID, reading.ZoneID, rfc3339ms(reading.TS)},
		Type:     "telemetry",
		Readings: []FrameReading{{Metric: reading.Metric, Value: reading.Value, Unit: reading.Unit}},
	}
}

// NewTelemetryActuator builds a telemetry frame carrying a single actuator sample.
// Actuator state is house-scoped on the wire, so the envelope zone_id is null.
func NewTelemetryActuator(sample domain.ActuatorSample) TelemetryFrame {
	return TelemetryFrame{
		envelope:  envelope{SchemaVersion, sample.GreenhouseID, nil, rfc3339ms(sample.TS)},
		Type:      "telemetry",
		Readings:  []FrameReading{},
		Actuators: []FrameActuator{{Actuator: sample.Actuator, Commanded: sample.Commanded, Observed: sample.Observed}},
	}
}

// NewStatus builds a status frame (greenhouse-scoped; zone_id null).
func NewStatus(greenhouseID string, ts time.Time, status domain.Connectivity, timeScale *float64) StatusFrame {
	return StatusFrame{
		envelope:  envelope{SchemaVersion, greenhouseID, nil, rfc3339ms(ts)},
		Type:      "status",
		Status:    status,
		TimeScale: timeScale,
	}
}

// NewEvent builds an event frame (greenhouse-scoped; zone_id null).
func NewEvent(event domain.Event) EventFrame {
	return EventFrame{
		envelope: envelope{SchemaVersion, event.GreenhouseID, nil, rfc3339ms(event.TS)},
		Type:     "event",
		Kind:     event.Kind,
		Severity: event.Severity,
		Message:  event.Message,
		Source:   event.Source,
	}
}

// NewDrift builds a drift frame (greenhouse-scoped; zone_id null).
func NewDrift(greenhouseID string, ts time.Time, drift bool) DriftFrame {
	return DriftFrame{
		envelope: envelope{SchemaVersion, greenhouseID, nil, rfc3339ms(ts)},
		Type:     "drift",
		Drift:    drift,
	}
}
