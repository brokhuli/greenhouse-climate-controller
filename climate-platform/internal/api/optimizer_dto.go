package api

import (
	"encoding/json"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// Wire shapes for the Phase 3 optimizer console (platform-dashboard-rest optimizer.json). The
// Go API composes these from the optimizer's own Service API shapes (internal/optimizer) plus
// platform-owned state (current setpoints, crop-safe bounds); the SPA reaches the optimizer
// only through here.

// optimizerStatusDTO is the service-health badge (OptimizerStatus): the Go API's derivation
// of the optimizer's internal /health, with "unavailable" synthesized when the optimizer is
// unreachable so the badge always renders rather than surfacing a proxy 5xx.
type optimizerStatusDTO struct {
	Status              string  `json:"status"`
	DegradedReason      *string `json:"degraded_reason"`
	Enabled             bool    `json:"enabled"`
	ReadOnlyReason      *string `json:"read_only_reason"`
	LastSuccessfulCycle *string `json:"last_successful_cycle_at"`
	CadenceSecs         int     `json:"cadence_secs"`
}

// fleetOptimizerSummaryDTO is the console overview (FleetOptimizerSummary): per-greenhouse
// latest outcome plus site aggregates.
type fleetOptimizerSummaryDTO struct {
	Greenhouses []fleetGreenhouseDTO `json:"greenhouses"`
	Rollup      fleetRollupDTO       `json:"rollup"`
}

// fleetGreenhouseDTO is one greenhouse's latest-cycle summary. reason_code is present only on
// an escalated outcome; a never-planned greenhouse is omitted from the list entirely, so the
// SPA reads its "No plan" state from the absence (status/created_at are required here).
type fleetGreenhouseDTO struct {
	GreenhouseID string  `json:"greenhouse_id"`
	Status       string  `json:"status"`
	ReasonCode   *string `json:"reason_code,omitempty"`
	Enabled      bool    `json:"enabled"`
	CreatedAt    string  `json:"created_at"`
}

type byOutcomeDTO struct {
	Applied   int `json:"applied"`
	Escalated int `json:"escalated"`
	Extended  int `json:"extended"`
}

type fleetRollupDTO struct {
	Backlog          int          `json:"backlog"`
	ByOutcome        byOutcomeDTO `json:"by_outcome"`
	OldestOpenAgeSec *int         `json:"oldest_open_age_secs"`
}

// escalationDTO is one held cycle (Escalation). The optimizer's escalation_id / opened_at are
// renamed to the contract's id / created_at.
type escalationDTO struct {
	ID             string  `json:"id"`
	GreenhouseID   string  `json:"greenhouse_id"`
	OptimizerRunID string  `json:"optimizer_run_id"`
	ReasonCode     string  `json:"reason_code"`
	ReasonClass    string  `json:"reason_class"`
	CreatedAt      string  `json:"created_at"`
	Message        *string `json:"message,omitempty"`
	Resolution     *string `json:"resolution"`
}

// modelStateDTO is the active backend + allowlist (ModelState) — structurally identical to the
// optimizer's own ModelStateResponse.
type modelStateDTO struct {
	Provider        string   `json:"provider"`
	Model           string   `json:"model"`
	PromptVersion   string   `json:"prompt_version"`
	Role            string   `json:"role"`
	AvailableModels []string `json:"available_models"`
}

// enableStateDTO is the service-wide enable / read-only state (EnableState).
type enableStateDTO struct {
	Enabled bool `json:"enabled"`
}

// greenhouseEnableStateDTO is one greenhouse's enable state (GreenhouseEnableState).
type greenhouseEnableStateDTO struct {
	GreenhouseID string `json:"greenhouse_id"`
	Enabled      bool   `json:"enabled"`
}

// cycleAcceptedDTO is the 202 ack for an on-demand cycle (CycleAccepted) — the run id to poll
// the plan endpoint with once the cycle completes.
type cycleAcceptedDTO struct {
	OptimizerRunID string `json:"optimizer_run_id"`
	GreenhouseID   string `json:"greenhouse_id"`
}

// optimizerPlanDetailDTO is one greenhouse's latest plan view plus its composed setpoint diff
// (OptimizerPlanDetail). diff is null when plan is null (a held cycle produced no bundle).
type optimizerPlanDetailDTO struct {
	Plan optimizerPlanViewDTO `json:"plan"`
	Diff *setpointDiffDTO     `json:"diff"`
}

// optimizerPlanViewDTO flattens the optimizer's PlanRecord (OptimizerPlanView). plan is null on
// a pre-planner held cycle.
type optimizerPlanViewDTO struct {
	OptimizerRunID string       `json:"optimizer_run_id"`
	GreenhouseID   string       `json:"greenhouse_id"`
	CreatedAt      string       `json:"created_at"`
	Horizon        horizonDTO   `json:"horizon"`
	Backend        backendDTO   `json:"backend"`
	Outcome        outcomeDTO   `json:"outcome"`
	Plan           *planBodyDTO `json:"plan"`
}

type horizonDTO struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

type backendDTO struct {
	Provider      string `json:"provider"`
	Model         string `json:"model"`
	PromptVersion string `json:"prompt_version"`
	Role          string `json:"role"`
}

type outcomeDTO struct {
	Status     string  `json:"status"`
	ReasonCode *string `json:"reason_code"`
	Message    *string `json:"message"`
}

// planBodyDTO is the OptimizerPlan the panel renders. immediate_setpoints and objective_scores
// are carried as the optimizer's own raw JSON — structurally the contract's already.
type planBodyDTO struct {
	Confidence         float64         `json:"confidence"`
	Explanation        string          `json:"explanation"`
	ImmediateSetpoints json.RawMessage `json:"immediate_setpoints"`
	ObjectiveScores    json.RawMessage `json:"objective_scores,omitempty"`
}

// setpointDiffDTO is the Go-API-composed diff (SetpointDiff): the plan's proposed patch against
// the greenhouse's current bundle and its crop-safe bounds — both platform-owned.
type setpointDiffDTO struct {
	Proposed json.RawMessage          `json:"proposed"`
	Current  domain.Setpoints         `json:"current"`
	Bounds   map[string]fieldBoundDTO `json:"bounds"`
}

type fieldBoundDTO struct {
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}
