package optimizer

import (
	"encoding/json"
	"time"
)

// These mirror the optimizer's service/schemas.py and its models/plan.py — the optimizer's
// own internal surface, not a versioned contract. The api package maps them onto the
// versioned platform-dashboard-rest optimizer shapes the SPA consumes. Fields the mapping
// does not use are omitted rather than carried dead.

// Health mirrors HealthResponse (spec 09). status is "healthy" | "degraded"; the frontend's
// third state, "unavailable", is synthesized by the Go API when the optimizer is unreachable
// and never appears here.
type Health struct {
	Status              string     `json:"status"`
	DegradedReason      *string    `json:"degraded_reason"`
	Enabled             bool       `json:"enabled"`
	ReadOnlyReason      *string    `json:"read_only_reason"`
	LastSuccessfulCycle *time.Time `json:"last_successful_cycle_at"`
	EscalationBacklog   int        `json:"escalation_backlog"`
	CadenceSecs         int        `json:"cadence_secs"`
}

// FleetGreenhouse mirrors one entry of FleetResponse.greenhouses. status/reason_code/
// created_at are null until the greenhouse has had a cycle; the mapping omits a
// never-planned greenhouse so the SPA reads its "No plan" state from the absence.
type FleetGreenhouse struct {
	GreenhouseID   string     `json:"greenhouse_id"`
	Enabled        bool       `json:"enabled"`
	Status         *string    `json:"status"`
	ReasonCode     *string    `json:"reason_code"`
	CreatedAt      *time.Time `json:"created_at"`
	OptimizerRunID *string    `json:"optimizer_run_id"`
}

// FleetRollup mirrors FleetRollupResponse.
type FleetRollup struct {
	Backlog                        int      `json:"backlog"`
	Applied                        int      `json:"applied"`
	Escalated                      int      `json:"escalated"`
	Extended                       int      `json:"extended"`
	OldestOpenEscalationAgeSeconds *float64 `json:"oldest_open_escalation_age_seconds"`
}

// Fleet mirrors FleetResponse.
type Fleet struct {
	Greenhouses []FleetGreenhouse `json:"greenhouses"`
	Rollup      FleetRollup       `json:"rollup"`
}

// Escalation mirrors EscalationResponse. The optimizer names the id escalation_id and the
// raise time opened_at; the frontend contract renames them id and created_at.
type Escalation struct {
	EscalationID   string    `json:"escalation_id"`
	GreenhouseID   string    `json:"greenhouse_id"`
	ReasonCode     string    `json:"reason_code"`
	ReasonClass    string    `json:"reason_class"`
	OptimizerRunID string    `json:"optimizer_run_id"`
	OpenedAt       time.Time `json:"opened_at"`
	Message        *string   `json:"message"`
	Resolution     *string   `json:"resolution"`
}

// ModelState mirrors ModelStateResponse — structurally the frontend ModelState already.
type ModelState struct {
	Provider        string   `json:"provider"`
	Model           string   `json:"model"`
	PromptVersion   string   `json:"prompt_version"`
	Role            string   `json:"role"`
	AvailableModels []string `json:"available_models"`
}

// EnableState mirrors EnableStateResponse (the extra reason/changed_at are ignored — the
// frontend EnableState carries only enabled).
type EnableState struct {
	Enabled bool `json:"enabled"`
}

// GreenhouseEnableState mirrors GreenhouseEnableStateResponse.
type GreenhouseEnableState struct {
	GreenhouseID string `json:"greenhouse_id"`
	Enabled      bool   `json:"enabled"`
}

// --- request bodies ---

// CycleRequest is the on-demand-cycle body ({ reason? }).
type CycleRequest struct {
	Reason *string `json:"reason,omitempty"`
}

// ResolveRequest is the escalation-resolve body ({ reason? }).
type ResolveRequest struct {
	Reason *string `json:"reason,omitempty"`
}

// ModelSelection is the model-switch body ({ model, reason? }).
type ModelSelection struct {
	Model  string  `json:"model"`
	Reason *string `json:"reason,omitempty"`
}

// EnableRequest is the pause/resume body ({ enabled, reason? }), shared by both enable scopes.
type EnableRequest struct {
	Enabled bool    `json:"enabled"`
	Reason  *string `json:"reason,omitempty"`
}

// --- plan record (models/plan.py PlanRecord) ---

// Horizon mirrors the adaptive planning window.
type Horizon struct {
	Start time.Time `json:"start"`
	End   time.Time `json:"end"`
}

// Backend mirrors the plan provenance (provider, model, prompt_version, role).
type Backend struct {
	Provider      string `json:"provider"`
	Model         string `json:"model"`
	PromptVersion string `json:"prompt_version"`
	Role          string `json:"role"`
}

// Outcome mirrors what the gates decided for a cycle.
type Outcome struct {
	Status     string  `json:"status"`
	ReasonCode *string `json:"reason_code"`
	Message    *string `json:"message"`
}

// Plan is the subset of the optimizer's OptimizerPlan the frontend renders. immediate_setpoints
// and objective_scores are carried as raw JSON: the optimizer's shapes are structurally the
// frontend's, so re-emitting them verbatim avoids a lossy field-by-field remap (and the
// diff's proposed patch reuses ImmediateSetpoints directly).
type Plan struct {
	Confidence         float64         `json:"confidence"`
	Explanation        string          `json:"explanation"`
	ImmediateSetpoints json.RawMessage `json:"immediate_setpoints"`
	ObjectiveScores    json.RawMessage `json:"objective_scores"`
}

// PlanRecord mirrors models/plan.py PlanRecord. schema_version and source_plan_id exist
// upstream but the frontend view drops them.
type PlanRecord struct {
	OptimizerRunID string    `json:"optimizer_run_id"`
	GreenhouseID   string    `json:"greenhouse_id"`
	CreatedAt      time.Time `json:"created_at"`
	Horizon        Horizon   `json:"horizon"`
	Backend        Backend   `json:"backend"`
	Plan           *Plan     `json:"plan"`
	Outcome        Outcome   `json:"outcome"`
}
