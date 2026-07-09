package domain

import "time"

// ProfileStage is one growth stage of a crop profile and the target bundle it applies, plus
// an optional crop-safe envelope the stage's targets may be refined within
// (contracts/frontend-rest ProfileStage).
type ProfileStage struct {
	Stage   string       `json:"stage"`
	Targets Setpoints    `json:"targets"`
	Bounds  *StageBounds `json:"bounds,omitempty"`
}

// Bound is a crop-safe [min, max] envelope for one scalar climate target — the range the Phase 3
// optimizer may refine that target within, never outside (RFC-005, optimizer constraint engine).
type Bound struct {
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}

// StageBounds is a growth stage's crop-safe envelope: one optional Bound per scalar climate target.
// It is the canonical envelope the platform enforces on optimizer setpoint writes and exposes to the
// optimizer via the planning-context read. An absent field means no crop-specific envelope for that
// target — only the generic physical bound applies. Time-of-day and per-zone irrigation targets are
// not optimizer-refined and carry no envelope.
type StageBounds struct {
	TemperatureDayC              *Bound `json:"temperature_day_c,omitempty"`
	TemperatureNightC            *Bound `json:"temperature_night_c,omitempty"`
	HumidityLowPct               *Bound `json:"humidity_low_pct,omitempty"`
	HumidityHighPct              *Bound `json:"humidity_high_pct,omitempty"`
	HumidityDeadbandPct          *Bound `json:"humidity_deadband_pct,omitempty"`
	CO2TargetPpm                 *Bound `json:"co2_target_ppm,omitempty"`
	CO2VentInterlockThresholdPct *Bound `json:"co2_vent_interlock_threshold_pct,omitempty"`
	VPDTargetKpa                 *Bound `json:"vpd_target_kpa,omitempty"`
	DLITargetMol                 *Bound `json:"dli_target_mol,omitempty"`
}

// CropProfile is a named, stage-aware bundle of climate + irrigation targets for a crop —
// the reusable library entry an operator assigns to a greenhouse (platform §1,
// contracts/frontend-rest CropProfile).
type CropProfile struct {
	ID     string         `json:"id"`
	Name   string         `json:"name"`
	Crop   string         `json:"crop"`
	Stages []ProfileStage `json:"stages"`
}

// Stage returns the named stage's target bundle; ok is false when the profile has no such
// stage — the guard the assignment path uses to reject an unknown stage.
func (p CropProfile) Stage(name string) (ProfileStage, bool) {
	for _, stage := range p.Stages {
		if stage.Stage == name {
			return stage, true
		}
	}
	return ProfileStage{}, false
}

// Assignment is which profile and growth stage are currently assigned to a greenhouse
// (contracts/frontend-rest Assignment).
type Assignment struct {
	GreenhouseID string `json:"greenhouse_id"`
	ProfileID    string `json:"profile_id"`
	Stage        string `json:"stage"`
}

// SetpointSource is the provenance of an intended-state revision (RFC-005): a crop-profile
// resolution, a sticky operator edit, or (Phase 3) an optimizer refinement.
type SetpointSource string

const (
	SourceProfile      SetpointSource = "profile"
	SourceOperatorEdit SetpointSource = "operator_edit"
	SourceOptimizer    SetpointSource = "optimizer"
)

// SetpointSources is the closed set of provenance sources, for validation.
var SetpointSources = map[SetpointSource]bool{
	SourceProfile:      true,
	SourceOperatorEdit: true,
	SourceOptimizer:    true,
}

// SetpointRevision is one entry in the append-only intended-state / provenance ledger
// (platform data model §1). The latest revision per greenhouse is its current intended
// state, which reconciliation keeps the controller faithful to.
type SetpointRevision struct {
	GreenhouseID string
	Revision     int64
	Source       SetpointSource
	Actor        string
	Reason       string
	Setpoints    Setpoints
	CreatedAt    time.Time
}
