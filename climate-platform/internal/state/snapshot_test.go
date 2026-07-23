package state

import (
	"testing"
	"time"
)

func TestSnapshotUnknownGreenhouse(t *testing.T) {
	f := NewFleet(10 * time.Second)
	if _, ok := f.Snapshot("gh-x"); ok {
		t.Fatal("unknown greenhouse should have no snapshot")
	}
}

func TestSetControllerModeAndActuatorHealth(t *testing.T) {
	f := NewFleet(10 * time.Second)
	f.SetControllerMode("gh-a", "interlock")
	f.SetActuatorHealth("gh-a", "fans", "", "stuck")
	f.SetActuatorHealth("gh-a", "irrigation_valve", "bench-a", "no_response")

	snapshot, ok := f.Snapshot("gh-a")
	if !ok {
		t.Fatal("snapshot missing")
	}
	if snapshot.Mode != "interlock" {
		t.Fatalf("mode = %q, want interlock", snapshot.Mode)
	}
	if got := snapshot.ActuatorHealth[ActuatorKey{Actuator: "fans"}]; got != "stuck" {
		t.Fatalf("house-level fans health = %q, want stuck", got)
	}
	// A per-zone actuator keeps its own entry rather than colliding with the house-level one.
	if got := snapshot.ActuatorHealth[ActuatorKey{Actuator: "irrigation_valve", ZoneID: "bench-a"}]; got != "no_response" {
		t.Fatalf("zone valve health = %q, want no_response", got)
	}
}

func TestSetSensorFaultsPreservesSince(t *testing.T) {
	f := NewFleet(10 * time.Second)
	t0 := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	stuck := map[FaultKey]string{{Component: "temperature"}: "stuck"}

	f.SetSensorFaults("gh-a", stuck, t0)
	f.SetSensorFaults("gh-a", stuck, t0.Add(10*time.Minute))

	snapshot, _ := f.Snapshot("gh-a")
	fault := snapshot.SensorFaults[FaultKey{Component: "temperature"}]
	if !fault.Since.Equal(t0) {
		t.Fatalf("since = %v, want the first observation %v", fault.Since, t0)
	}
}

func TestSetSensorFaultsRestampsOnChangedKind(t *testing.T) {
	f := NewFleet(10 * time.Second)
	t0 := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	t1 := t0.Add(10 * time.Minute)

	f.SetSensorFaults("gh-a", map[FaultKey]string{{Component: "humidity"}: "stuck"}, t0)
	f.SetSensorFaults("gh-a", map[FaultKey]string{{Component: "humidity"}: "out_of_range"}, t1)

	snapshot, _ := f.Snapshot("gh-a")
	fault := snapshot.SensorFaults[FaultKey{Component: "humidity"}]
	if fault.Kind != "out_of_range" {
		t.Fatalf("kind = %q, want out_of_range", fault.Kind)
	}
	// A different fault on the same component is a different fault, not a continuation.
	if !fault.Since.Equal(t1) {
		t.Fatalf("since = %v, want the re-stamped %v", fault.Since, t1)
	}
}

func TestSetSensorFaultsClearsAbsent(t *testing.T) {
	f := NewFleet(10 * time.Second)
	t0 := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)

	f.SetSensorFaults("gh-a", map[FaultKey]string{{Component: "co2"}: "stuck"}, t0)
	f.SetSensorFaults("gh-a", map[FaultKey]string{}, t0.Add(time.Minute))

	snapshot, _ := f.Snapshot("gh-a")
	if len(snapshot.SensorFaults) != 0 {
		t.Fatalf("cleared fault still present: %v", snapshot.SensorFaults)
	}
}

func TestSnapshotMapsAreCopies(t *testing.T) {
	f := NewFleet(10 * time.Second)
	t0 := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	f.SetActuatorHealth("gh-a", "heater", "", "ok")
	f.SetSensorFaults("gh-a", map[FaultKey]string{{Component: "par"}: "stuck"}, t0)

	first, _ := f.Snapshot("gh-a")
	first.ActuatorHealth[ActuatorKey{Actuator: "heater"}] = "stuck"
	delete(first.SensorFaults, FaultKey{Component: "par"})

	second, _ := f.Snapshot("gh-a")
	if second.ActuatorHealth[ActuatorKey{Actuator: "heater"}] != "ok" {
		t.Fatal("mutating a snapshot's actuator map leaked into the fleet")
	}
	if len(second.SensorFaults) != 1 {
		t.Fatal("mutating a snapshot's fault map leaked into the fleet")
	}
}
