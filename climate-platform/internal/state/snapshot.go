package state

import "time"

// ActuatorKey identifies one actuator's readback health. ZoneID is "" for house-level
// actuators and the zone slug for per-zone ones (irrigation_valve).
type ActuatorKey struct {
	Actuator string
	ZoneID   string
}

// FaultKey identifies one active sensor fault: the faulted component (a metric name) and
// the zone it is scoped to ("" for greenhouse-scoped metrics).
type FaultKey struct {
	Component string
	ZoneID    string
}

// SensorFault is one active per-sensor fault as the platform last observed it. Kind is the
// controller's fault_type; Since is when the platform first saw this fault active.
type SensorFault struct {
	Kind  string
	Since time.Time
}

// ControllerSnapshot is a greenhouse's last-observed controller state: its operating mode,
// per-actuator readback health, and active sensor faults. It backs the planning-context
// read's data-quality block (contracts/platform-optimizer-planning-rest DataQuality), whose
// signals exist only on the retained gh/{id}/state frame and the actuator-state frames.
type ControllerSnapshot struct {
	// Mode is the controller's operating mode (normal / degraded / interlock), or "" before
	// any state frame has been observed.
	Mode           string
	ActuatorHealth map[ActuatorKey]string
	SensorFaults   map[FaultKey]SensorFault
}

// SetControllerMode records a greenhouse's operating mode from its system-state frame.
func (f *Fleet) SetControllerMode(id, mode string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ensure(id).controllerMode = mode
}

// SetActuatorHealth records one actuator's readback health (ok / stuck / no_response) from
// its actuator-state frame. Per-zone actuators are keyed by their zone, so a zone's
// irrigation valve keeps its own health rather than sharing the house-level entry.
func (f *Fleet) SetActuatorHealth(id, actuator, zoneID, health string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ent := f.ensure(id)
	if ent.actuatorHealth == nil {
		ent.actuatorHealth = make(map[ActuatorKey]string)
	}
	ent.actuatorHealth[ActuatorKey{Actuator: actuator, ZoneID: zoneID}] = health
}

// SetSensorFaults replaces a greenhouse's active sensor-fault set from its system-state
// frame, which carries the whole active set every tick. A fault already active keeps its
// original Since; a newly seen one is stamped with ts; one absent from the frame has
// cleared and is dropped.
//
// Since is first-observed-by-the-platform, not first-occurred: the frame carries no
// per-fault timestamp. After a platform restart the retained frame re-primes a still-active
// fault with that frame's ts, so Since can read younger than the fault truly is.
func (f *Fleet) SetSensorFaults(id string, faults map[FaultKey]string, ts time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ent := f.ensure(id)
	active := make(map[FaultKey]SensorFault, len(faults))
	for key, kind := range faults {
		since := ts
		// Carry the original Since forward only while the fault keeps its kind; a changed
		// kind on the same component is a different fault.
		if previous, ok := ent.sensorFaults[key]; ok && previous.Kind == kind {
			since = previous.Since
		}
		active[key] = SensorFault{Kind: kind, Since: since}
	}
	ent.sensorFaults = active
}

// Snapshot returns a greenhouse's controller snapshot. The maps are copies, so a caller may
// read them without holding the lock. found is false for an unknown greenhouse.
func (f *Fleet) Snapshot(id string) (ControllerSnapshot, bool) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	ent, ok := f.entries[id]
	if !ok {
		return ControllerSnapshot{}, false
	}
	snapshot := ControllerSnapshot{
		Mode:           ent.controllerMode,
		ActuatorHealth: make(map[ActuatorKey]string, len(ent.actuatorHealth)),
		SensorFaults:   make(map[FaultKey]SensorFault, len(ent.sensorFaults)),
	}
	for key, health := range ent.actuatorHealth {
		snapshot.ActuatorHealth[key] = health
	}
	for key, fault := range ent.sensorFaults {
		snapshot.SensorFaults[key] = fault
	}
	return snapshot, true
}
