// Package state holds the platform's in-memory live view of the fleet: each
// greenhouse's derived connectivity, its simulation time-scale, and its latest
// house temperature. Liveness is a product of ingestion (ingestion §4), so the
// ingester writes here and the REST API / WebSocket hub read from here — cheaply,
// without a database round-trip per fleet card.
package state

import (
	"sync"
	"time"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// Live is a greenhouse's current derived live state.
type Live struct {
	Status      domain.Connectivity
	TimeScale   *float64
	Temperature *float64
	Humidity    *float64
	CO2         *float64
	DLI         *float64
	LastSeen    time.Time
}

type entry struct {
	lastSeen    time.Time
	timeScale   *float64
	temperature *float64
	humidity    *float64
	co2         *float64
	dli         *float64
	degraded    bool // a non-critical fault / unhealthy controller is active
	status      domain.Connectivity
}

// Fleet is the concurrency-safe live view, keyed by greenhouse id.
type Fleet struct {
	mu           sync.RWMutex
	entries      map[string]*entry
	offlineAfter time.Duration
}

// NewFleet builds an empty fleet view. offlineAfter is the 1× no-contact horizon;
// it is stretched for slower simulated clocks (a 0.25× greenhouse reports ~4× less
// often, so it is not stale just because it is quiet).
func NewFleet(offlineAfter time.Duration) *Fleet {
	return &Fleet{entries: make(map[string]*entry), offlineAfter: offlineAfter}
}

func (f *Fleet) ensure(id string) *entry {
	ent, ok := f.entries[id]
	if !ok {
		ent = &entry{status: domain.StatusOffline}
		f.entries[id] = ent
	}
	return ent
}

// deriveLocked recomputes an entry's status from freshness and the degraded flag.
func (f *Fleet) deriveLocked(ent *entry, now time.Time) domain.Connectivity {
	if ent.lastSeen.IsZero() || now.Sub(ent.lastSeen) > f.effectiveOffline(ent) {
		return domain.StatusOffline
	}
	if ent.degraded {
		return domain.StatusDegraded
	}
	return domain.StatusOnline
}

func (f *Fleet) effectiveOffline(ent *entry) time.Duration {
	scale := 1.0
	if ent.timeScale != nil && *ent.timeScale > 0 {
		scale = *ent.timeScale
	}
	if scale < domain.MinTimeScale {
		scale = domain.MinTimeScale
	}
	return time.Duration(float64(f.offlineAfter) / scale)
}

func snapshot(ent *entry) Live {
	return Live{Status: ent.status, TimeScale: ent.timeScale, Temperature: ent.temperature, Humidity: ent.humidity, CO2: ent.co2, DLI: ent.dli, LastSeen: ent.lastSeen}
}

// Observe records that a message arrived for a greenhouse at time ts and recomputes
// its status. It returns the resulting live state and whether a status frame should be
// emitted (status changed). ts is the controller's clock instant from the envelope.
func (f *Fleet) Observe(id string, ts time.Time) (Live, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ent := f.ensure(id)
	if ts.After(ent.lastSeen) {
		ent.lastSeen = ts
	}
	return f.applyLocked(ent, ts)
}

// SetDegraded marks (or clears) a greenhouse's degraded condition — a non-critical
// fault or an unhealthy controller report — alongside an observation at ts.
func (f *Fleet) SetDegraded(id string, degraded bool, ts time.Time) (Live, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ent := f.ensure(id)
	if ts.After(ent.lastSeen) {
		ent.lastSeen = ts
	}
	ent.degraded = degraded
	return f.applyLocked(ent, ts)
}

// SetTimeScale updates a greenhouse's simulation time-scale (nil clears it). A change
// is status-frame-worthy because the status frame carries time_scale.
func (f *Fleet) SetTimeScale(id string, scale *float64) (Live, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ent := f.ensure(id)
	changed := !floatPtrEqual(ent.timeScale, scale)
	ent.timeScale = scale
	live := snapshot(ent)
	live.Status = ent.status
	return live, changed
}

// SetTemperature updates a greenhouse's latest house temperature (for the fleet card).
func (f *Fleet) SetTemperature(id string, temperature *float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ent := f.ensure(id)
	ent.temperature = temperature
}

// SetHumidity updates a greenhouse's latest house humidity (for the fleet card).
func (f *Fleet) SetHumidity(id string, humidity *float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ent := f.ensure(id)
	ent.humidity = humidity
}

// SetCO2 updates a greenhouse's latest house CO₂ (for the fleet card).
func (f *Fleet) SetCO2(id string, co2 *float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ent := f.ensure(id)
	ent.co2 = co2
}

// SetDLI updates a greenhouse's latest accumulated Daily Light Integral (for the fleet card).
func (f *Fleet) SetDLI(id string, dli *float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ent := f.ensure(id)
	ent.dli = dli
}

// applyLocked recomputes status and reports whether it changed. Caller holds the lock.
func (f *Fleet) applyLocked(ent *entry, now time.Time) (Live, bool) {
	previous := ent.status
	ent.status = f.deriveLocked(ent, now)
	return snapshot(ent), ent.status != previous
}

// Sweep recomputes every greenhouse's status at now and returns those whose status
// changed (e.g. fell offline). Drives the periodic liveness check.
func (f *Fleet) Sweep(now time.Time) map[string]Live {
	f.mu.Lock()
	defer f.mu.Unlock()
	changed := make(map[string]Live)
	for id, ent := range f.entries {
		previous := ent.status
		ent.status = f.deriveLocked(ent, now)
		if ent.status != previous {
			changed[id] = snapshot(ent)
		}
	}
	return changed
}

// Get returns a greenhouse's live state.
func (f *Fleet) Get(id string) (Live, bool) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	ent, ok := f.entries[id]
	if !ok {
		return Live{}, false
	}
	return snapshot(ent), true
}

// All returns a copy of every greenhouse's live state.
func (f *Fleet) All() map[string]Live {
	f.mu.RLock()
	defer f.mu.RUnlock()
	result := make(map[string]Live, len(f.entries))
	for id, ent := range f.entries {
		result[id] = snapshot(ent)
	}
	return result
}

// Remove drops a greenhouse from the live view (on retire).
func (f *Fleet) Remove(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.entries, id)
}

func floatPtrEqual(a, b *float64) bool {
	switch {
	case a == nil && b == nil:
		return true
	case a == nil || b == nil:
		return false
	default:
		return *a == *b
	}
}
