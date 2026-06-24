// Package domain holds the platform's shared vocabulary: RFC-007 identity slugs,
// the closed enums the contracts fix (metrics, actuators, connectivity, event
// kinds/severities), the metric→unit binding, and the canonical telemetry/event
// records that the store, ingester, REST API, and WebSocket hub all pass around.
//
// It deliberately mirrors the wire contracts under contracts/ (mqtt, frontend-rest,
// frontend-ws) so there is one identity and one set of enums with no translation layer.
package domain

import (
	"regexp"
	"time"
)

// slugPattern is the RFC-007 identity rule: a lowercase kebab slug. The same slug
// keys MQTT topics, REST paths, and DB rows (contracts/.../common Slug).
var slugPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// ValidSlug reports whether s is a well-formed RFC-007 identity slug.
func ValidSlug(s string) bool { return slugPattern.MatchString(s) }

// MinTimeScale and MaxTimeScale bound the accepted simulation time-scale (controller
// HAL §7): the sim REST surface accepts edits in this range and telemetry reports
// within it. Liveness sizes its sweep cadence to MaxTimeScale (the fastest clock).
const (
	MinTimeScale = 0.25
	MaxTimeScale = 8.0
)

// Connectivity is a greenhouse's controller connectivity as the platform derives it
// from ingestion: online = fresh telemetry, degraded = a non-critical fault or stale
// stream, offline = no contact. Offline is data absence, not a fault.
type Connectivity string

const (
	StatusOnline   Connectivity = "online"
	StatusDegraded Connectivity = "degraded"
	StatusOffline  Connectivity = "offline"
)

// Metric is the closed set of measured/derived quantities (RFC-007).
// soil_moisture is zone-scoped; the rest are greenhouse-scoped.
var Metrics = map[string]bool{
	"temperature":   true,
	"humidity":      true,
	"co2":           true,
	"par":           true,
	"vpd":           true,
	"soil_moisture": true,
}

// metricUnits binds each metric to its RFC-007 unit.
var metricUnits = map[string]string{
	"temperature":   "°C",
	"humidity":      "%RH",
	"co2":           "ppm",
	"par":           "µmol·m⁻²·s⁻¹",
	"vpd":           "kPa",
	"soil_moisture": "VWC",
}

// MetricUnit returns the unit bound to a metric, or "" if the metric is unknown.
func MetricUnit(metric string) string { return metricUnits[metric] }

// Actuators is the closed set of actuator names (physical-system §Outputs).
var Actuators = map[string]bool{
	"heater":           true,
	"fans":             true,
	"roof_vents":       true,
	"misters":          true,
	"co2_injector":     true,
	"grow_lights":      true,
	"shade_screen":     true,
	"irrigation_valve": true,
}

// EventKinds is the closed set of activity-feed event kinds (frontend-rest EventEntry).
// "drift" and "profile_applied" exist in the contract but are produced only in 2b.
var EventKinds = map[string]bool{
	"fault":           true,
	"interlock":       true,
	"profile_applied": true,
	"setpoint_edit":   true,
	"drift":           true,
}

// EventSeverities is the platform's dashboard grading (distinct from the controller's
// warning/alarm fault severity).
var EventSeverities = map[string]bool{
	"info":     true,
	"warning":  true,
	"critical": true,
}

// Reading is one time-stamped sensor sample as stored and served.
type Reading struct {
	GreenhouseID string
	ZoneID       *string // nil for greenhouse-scoped metrics
	Metric       string
	Value        float64
	Unit         string
	TS           time.Time
}

// ActuatorSample is one time-stamped actuator sample, with the MQTT {on, level_pct}
// shape flattened to a 0–100 position (on/off devices report 0/100).
type ActuatorSample struct {
	GreenhouseID string
	ZoneID       *string // nil for house-level actuators
	Actuator     string
	Commanded    float64
	Observed     *float64
	TS           time.Time
}

// Event is one activity-feed entry (fault, interlock, setpoint edit, …).
type Event struct {
	GreenhouseID string
	TS           time.Time
	Kind         string
	Severity     string
	Message      string
	Source       string
}
