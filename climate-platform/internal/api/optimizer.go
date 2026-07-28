package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/optimizer"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/reconcile"
)

// The optimizer console proxy/aggregate (platform interfaces §3). Reads project the
// optimizer's own Service API onto the versioned dashboard shapes; three endpoints do more
// than pass through: /status derives the health badge (synthesizing "unavailable" when the
// optimizer is unreachable), /fleet renames + filters the rollup, and /greenhouses/{id}/plan
// composes the setpoint diff from platform-owned current setpoints + crop-safe bounds.

// --- status: derive the health badge ---

func (s *Server) getOptimizerStatus(c echo.Context) error {
	// A nil client (optimizer not configured) or a transport failure both mean the console
	// cannot see the optimizer — synthesize "unavailable" rather than a proxy 5xx so the badge
	// always renders.
	if s.optimizer == nil {
		return c.JSON(http.StatusOK, s.unavailableStatus())
	}
	health, err := s.optimizer.Health(c.Request().Context())
	if err != nil {
		return c.JSON(http.StatusOK, s.unavailableStatus())
	}
	s.lastOptimizerCadence.Store(int64(health.CadenceSecs))
	var lastCycle *string
	if health.LastSuccessfulCycle != nil {
		formatted := fmtTS(*health.LastSuccessfulCycle)
		lastCycle = &formatted
	}
	return c.JSON(http.StatusOK, optimizerStatusDTO{
		Status:              health.Status,
		DegradedReason:      health.DegradedReason,
		Enabled:             health.Enabled,
		ReadOnlyReason:      health.ReadOnlyReason,
		LastSuccessfulCycle: lastCycle,
		CadenceSecs:         health.CadenceSecs,
	})
}

// unavailableStatus is the badge the Go API synthesizes when it cannot reach the optimizer.
// The cadence is the last one /health reported (so the "last cycle vs cadence" staleness read
// still holds), falling back to the configured default before any successful call.
func (s *Server) unavailableStatus() optimizerStatusDTO {
	cadence := int(s.lastOptimizerCadence.Load())
	if cadence == 0 {
		cadence = s.optimizerCadenceSecs
	}
	return optimizerStatusDTO{
		Status:              "unavailable",
		Enabled:             false,
		LastSuccessfulCycle: nil,
		CadenceSecs:         cadence,
	}
}

// --- fleet: rename + filter the rollup ---

func (s *Server) getOptimizerFleet(c echo.Context) error {
	if s.optimizer == nil {
		return respondError(c, http.StatusBadGateway, "optimizer unavailable")
	}
	fleet, err := s.optimizer.Fleet(c.Request().Context())
	if err != nil {
		return s.optimizerFail(c, err)
	}

	statusFilter := c.QueryParam("status")
	greenhouseFilter := c.QueryParam("greenhouse_id")

	greenhouses := make([]fleetGreenhouseDTO, 0, len(fleet.Greenhouses))
	for _, gh := range fleet.Greenhouses {
		// A never-cycled greenhouse (null status/created_at) still belongs on the roster so its
		// Disabled/No-plan state renders; only a *status* filter excludes it, since it has none.
		if statusFilter != "" && (gh.Status == nil || *gh.Status != statusFilter) {
			continue
		}
		if greenhouseFilter != "" && gh.GreenhouseID != greenhouseFilter {
			continue
		}
		var createdAt *string
		if gh.CreatedAt != nil {
			formatted := fmtTS(*gh.CreatedAt)
			createdAt = &formatted
		}
		message := gh.Message
		if gh.Status != nil && *gh.Status == "applied" && s.store != nil {
			if summary, summaryErr := s.appliedOptimizerSetpointChanges(c.Request().Context(), gh.GreenhouseID, gh.OptimizerRunID); summaryErr != nil {
				s.log.Warn("compose applied optimizer summary", "greenhouse_id", gh.GreenhouseID, "err", summaryErr)
			} else if summary != "" {
				message = &summary
			}
		}
		greenhouses = append(greenhouses, fleetGreenhouseDTO{
			GreenhouseID: gh.GreenhouseID,
			Status:       gh.Status,
			ReasonCode:   gh.ReasonCode,
			Message:      message,
			Enabled:      gh.Enabled,
			CreatedAt:    createdAt,
			InFlight:     gh.InFlight,
			CurrentStage: gh.CurrentStage,
		})
	}

	var oldest *int
	if fleet.Rollup.OldestOpenEscalationAgeSeconds != nil {
		age := int(*fleet.Rollup.OldestOpenEscalationAgeSeconds)
		oldest = &age
	}
	return c.JSON(http.StatusOK, fleetOptimizerSummaryDTO{
		Greenhouses: greenhouses,
		Rollup: fleetRollupDTO{
			Backlog: fleet.Rollup.Backlog,
			ByOutcome: byOutcomeDTO{
				Applied:   fleet.Rollup.Applied,
				Unchanged: fleet.Rollup.Unchanged,
				Held:      fleet.Rollup.Held,
				Failed:    fleet.Rollup.Failed,
			},
			OldestOpenAgeSec: oldest,
		},
	})
}

// --- escalations ---

func (s *Server) listOptimizerEscalations(c echo.Context) error {
	if s.optimizer == nil {
		return respondError(c, http.StatusBadGateway, "optimizer unavailable")
	}
	escalations, err := s.optimizer.Escalations(c.Request().Context())
	if err != nil {
		return s.optimizerFail(c, err)
	}
	out := make([]escalationDTO, 0, len(escalations))
	for _, escalation := range escalations {
		out = append(out, mapEscalation(escalation))
	}
	return c.JSON(http.StatusOK, out)
}

func (s *Server) resolveOptimizerEscalation(c echo.Context) error {
	if s.optimizer == nil {
		return respondError(c, http.StatusBadGateway, "optimizer unavailable")
	}
	var req optimizer.ResolveRequest
	if err := c.Bind(&req); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid JSON body")
	}
	escalation, err := s.optimizer.ResolveEscalation(c.Request().Context(), c.Param("escalationID"), bearerToken(c), req)
	if err != nil {
		return s.optimizerFail(c, err)
	}
	// The platform owns the resolve, so it emits the audit event directly (no optimizer report path):
	// an operator closed a standing escalation (optimizer_resolved, spec 05 §Events).
	s.emitEvent(c.Request().Context(), domain.Event{
		GreenhouseID: escalation.GreenhouseID,
		TS:           time.Now().UTC(),
		Kind:         "optimizer_resolved",
		Severity:     "info",
		Message:      fmt.Sprintf("optimizer escalation resolved (run %s; reason %s)", shortRunID(escalation.OptimizerRunID), escalation.ReasonCode),
		Source:       "optimizer",
	})
	return c.JSON(http.StatusOK, mapEscalation(escalation))
}

// mapEscalation renames the optimizer's escalation_id / opened_at to the contract's id /
// created_at; reason_class and resolution ride through unchanged.
func mapEscalation(escalation optimizer.Escalation) escalationDTO {
	return escalationDTO{
		ID:             escalation.EscalationID,
		GreenhouseID:   escalation.GreenhouseID,
		OptimizerRunID: escalation.OptimizerRunID,
		ReasonCode:     escalation.ReasonCode,
		ReasonClass:    escalation.ReasonClass,
		CreatedAt:      fmtTS(escalation.OpenedAt),
		Message:        escalation.Message,
		Resolution:     escalation.Resolution,
	}
}

// --- model + enable: near pass-through ---

func (s *Server) getOptimizerModel(c echo.Context) error {
	if s.optimizer == nil {
		return respondError(c, http.StatusBadGateway, "optimizer unavailable")
	}
	model, err := s.optimizer.Model(c.Request().Context())
	if err != nil {
		return s.optimizerFail(c, err)
	}
	return c.JSON(http.StatusOK, modelStateDTO(model))
}

func (s *Server) setOptimizerModel(c echo.Context) error {
	if s.optimizer == nil {
		return respondError(c, http.StatusBadGateway, "optimizer unavailable")
	}
	var req optimizer.ModelSelection
	if err := c.Bind(&req); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid JSON body")
	}
	model, err := s.optimizer.SetModel(c.Request().Context(), bearerToken(c), req)
	if err != nil {
		return s.optimizerFail(c, err)
	}
	return c.JSON(http.StatusOK, modelStateDTO(model))
}

func (s *Server) getOptimizerEnabled(c echo.Context) error {
	if s.optimizer == nil {
		return respondError(c, http.StatusBadGateway, "optimizer unavailable")
	}
	state, err := s.optimizer.Enabled(c.Request().Context())
	if err != nil {
		return s.optimizerFail(c, err)
	}
	return c.JSON(http.StatusOK, enableStateDTO{Enabled: state.Enabled})
}

func (s *Server) setOptimizerEnabled(c echo.Context) error {
	if s.optimizer == nil {
		return respondError(c, http.StatusBadGateway, "optimizer unavailable")
	}
	var req optimizer.EnableRequest
	if err := c.Bind(&req); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid JSON body")
	}
	state, err := s.optimizer.SetEnabled(c.Request().Context(), bearerToken(c), req)
	if err != nil {
		return s.optimizerFail(c, err)
	}
	return c.JSON(http.StatusOK, enableStateDTO{Enabled: state.Enabled})
}

func (s *Server) getGreenhouseOptimizerEnabled(c echo.Context) error {
	if s.optimizer == nil {
		return respondError(c, http.StatusBadGateway, "optimizer unavailable")
	}
	state, err := s.optimizer.GreenhouseEnabled(c.Request().Context(), c.Param("id"))
	if err != nil {
		return s.optimizerFail(c, err)
	}
	return c.JSON(http.StatusOK, greenhouseEnableStateDTO{GreenhouseID: state.GreenhouseID, Enabled: state.Enabled})
}

func (s *Server) setGreenhouseOptimizerEnabled(c echo.Context) error {
	if s.optimizer == nil {
		return respondError(c, http.StatusBadGateway, "optimizer unavailable")
	}
	var req optimizer.EnableRequest
	if err := c.Bind(&req); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid JSON body")
	}
	state, err := s.optimizer.SetGreenhouseEnabled(c.Request().Context(), c.Param("id"), bearerToken(c), req)
	if err != nil {
		return s.optimizerFail(c, err)
	}
	return c.JSON(http.StatusOK, greenhouseEnableStateDTO{GreenhouseID: state.GreenhouseID, Enabled: state.Enabled})
}

// --- cycle: 202 with the run id to poll ---

func (s *Server) triggerOptimizerCycle(c echo.Context) error {
	if s.optimizer == nil {
		return respondError(c, http.StatusBadGateway, "optimizer unavailable")
	}
	var req optimizer.CycleRequest
	if err := c.Bind(&req); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid JSON body")
	}
	accepted, err := s.optimizer.TriggerCycle(c.Request().Context(), c.Param("id"), bearerToken(c), req)
	if err != nil {
		return s.optimizerFail(c, err)
	}
	return c.JSON(http.StatusAccepted, cycleAcceptedDTO{
		OptimizerRunID: accepted.OptimizerRunID,
		GreenhouseID:   accepted.GreenhouseID,
	})
}

// --- plan: flatten + compose the setpoint diff ---

func (s *Server) getOptimizerPlan(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("id")
	if ok, err := s.requireGreenhouse(ctx, c, id); !ok {
		return err
	}
	if s.optimizer == nil {
		return respondError(c, http.StatusBadGateway, "optimizer unavailable")
	}
	record, err := s.optimizer.LatestPlan(ctx, id)
	if err != nil {
		// Plan records are deliberately in-memory in the optimizer, but a successful setpoint
		// submission is durable platform state. If the optimizer restarted after publishing, recover
		// the applied outcome from that provenance instead of telling the operator no cycle ran.
		if optimizer.StatusCode(err) == http.StatusNotFound {
			if durable, found, durableErr := s.durableAppliedOptimizerPlan(ctx, id); durableErr != nil {
				return s.fail(c, durableErr)
			} else if found {
				return c.JSON(http.StatusOK, optimizerPlanDetailDTO{Plan: durable, Diff: nil})
			}
		}
		return s.optimizerFail(c, err)
	}
	if record.Plan != nil {
		record.Plan.ImmediateSetpoints, err = compactJSONObject(record.Plan.ImmediateSetpoints)
		if err != nil {
			return s.fail(c, fmt.Errorf("normalize optimizer setpoint patch: %w", err))
		}
		if bytes.Equal(bytes.TrimSpace(record.Plan.ObjectiveScores), []byte("null")) {
			record.Plan.ObjectiveScores = nil
		}
	}

	view := toPlanView(record)
	// A pre-planner held cycle carries no plan, so there is no proposed bundle to diff.
	if record.Plan == nil {
		return c.JSON(http.StatusOK, optimizerPlanDetailDTO{Plan: view, Diff: nil})
	}
	diff, err := s.composeSetpointDiff(ctx, id, record.OptimizerRunID, record.Plan.ImmediateSetpoints)
	if err != nil {
		return s.fail(c, err)
	}
	return c.JSON(http.StatusOK, optimizerPlanDetailDTO{Plan: view, Diff: diff})
}

// durableAppliedOptimizerPlan recovers the minimal truthful plan view from the platform's
// append-only intended-state ledger. The optimizer owns rich plan detail in memory, so a restart
// loses the explanation and original patch; the applied bundle and its run provenance remain
// durable here. This keeps the detail card honest until the next cycle recreates full detail.
func (s *Server) durableAppliedOptimizerPlan(ctx context.Context, greenhouseID string) (optimizerPlanViewDTO, bool, error) {
	current, found, err := s.store.CurrentRevision(ctx, greenhouseID)
	if err != nil || !found || current.Source != domain.SourceOptimizer || current.OptimizerRunID == nil {
		return optimizerPlanViewDTO{}, false, err
	}
	model, err := s.optimizer.Model(ctx)
	if err != nil {
		return optimizerPlanViewDTO{}, false, err
	}
	message := "Setpoints were applied; detailed planner metadata was cleared when the optimizer restarted."
	createdAt := fmtTS(current.CreatedAt)
	return optimizerPlanViewDTO{
		OptimizerRunID: *current.OptimizerRunID,
		GreenhouseID:   greenhouseID,
		CreatedAt:      createdAt,
		// The original horizon belongs to the optimizer's volatile record. Use the durable applied
		// timestamp for both bounds rather than inventing a planning interval.
		Horizon: horizonDTO{Start: createdAt, End: createdAt},
		Backend: backendDTO{
			Provider: model.Provider, Model: model.Model, PromptVersion: model.PromptVersion, Role: model.Role,
		},
		Outcome: outcomeDTO{Status: "applied", Message: &message},
		Plan:    nil,
	}, true, nil
}

// toPlanView flattens the optimizer's PlanRecord onto the frontend OptimizerPlanView, dropping
// the fields the console does not render (schema_version, source_plan_id). backend and outcome
// are structurally identical, so they convert directly; the plan body carries its raw JSON
// through. plan stays null on a pre-planner held cycle.
func toPlanView(record optimizer.PlanRecord) optimizerPlanViewDTO {
	view := optimizerPlanViewDTO{
		OptimizerRunID: record.OptimizerRunID,
		GreenhouseID:   record.GreenhouseID,
		CreatedAt:      fmtTS(record.CreatedAt),
		Horizon:        horizonDTO{Start: fmtTS(record.Horizon.Start), End: fmtTS(record.Horizon.End)},
		Backend:        backendDTO(record.Backend),
		Outcome:        outcomeDTO(record.Outcome),
	}
	if record.Plan != nil {
		view.Plan = &planBodyDTO{
			Confidence:         record.Plan.Confidence,
			Explanation:        record.Plan.Explanation,
			ImmediateSetpoints: record.Plan.ImmediateSetpoints,
			ObjectiveScores:    record.Plan.ObjectiveScores,
		}
	}
	return view
}

// composeSetpointDiff pairs the plan's proposed patch with the greenhouse's current in-force
// bundle and its crop-safe bounds — both platform-owned, stitched here so the SPA reads one
// response. The bounds map is the scalar climate envelope flattened to the field names the
// diff keys by.
func (s *Server) composeSetpointDiff(ctx context.Context, id, optimizerRunID string, proposed []byte) (*setpointDiffDTO, error) {
	current, err := s.setpointsBeforeOptimizerRun(ctx, id, optimizerRunID)
	if err != nil {
		return nil, err
	}
	bounds, err := s.resolveStageBounds(ctx, id)
	if err != nil {
		return nil, err
	}
	return &setpointDiffDTO{
		Proposed: proposed,
		Current:  current,
		Bounds:   flattenClimateBounds(bounds),
	}, nil
}

// setpointsBeforeOptimizerRun returns the bundle an applied optimizer revision replaced. If the
// plan has not been applied yet (for example, an escalated proposal), the current bundle remains
// the correct comparison. Matching the run id prevents an older plan from borrowing a newer
// revision's baseline.
func (s *Server) setpointsBeforeOptimizerRun(ctx context.Context, id, optimizerRunID string) (domain.Setpoints, error) {
	current, found, err := s.store.CurrentRevision(ctx, id)
	if err != nil {
		return domain.Setpoints{}, err
	}
	if found && current.Source == domain.SourceOptimizer && current.OptimizerRunID != nil && *current.OptimizerRunID == optimizerRunID {
		previous, previousFound, previousErr := s.store.RevisionBefore(ctx, id, current.Revision)
		if previousErr != nil {
			return domain.Setpoints{}, previousErr
		}
		if previousFound {
			return previous.Setpoints, nil
		}
	}
	return s.currentSetpoints(ctx, id)
}

// compactJSONObject removes explicit null properties from the optimizer's partial-setpoint JSON.
// Pydantic's service response includes unset optional fields as null, while the dashboard contract
// represents an omitted setpoint as an absent property. Normalize that internal/service mismatch at
// the Go API boundary before validating it in the browser.
func compactJSONObject(raw []byte) (json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	for name, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			delete(fields, name)
		}
	}
	return json.Marshal(fields)
}

// appliedOptimizerSetpointChanges builds the successful pipeline message from durable revisions,
// giving the fleet row the same actionable feedback that failed/held pipeline rows already show.
func (s *Server) appliedOptimizerSetpointChanges(ctx context.Context, greenhouseID string, optimizerRunID *string) (string, error) {
	if optimizerRunID == nil {
		return "", nil
	}
	current, found, err := s.store.CurrentRevision(ctx, greenhouseID)
	if err != nil || !found || current.Source != domain.SourceOptimizer || current.OptimizerRunID == nil || *current.OptimizerRunID != *optimizerRunID {
		return "", err
	}
	previous, found, err := s.store.RevisionBefore(ctx, greenhouseID, current.Revision)
	if err != nil || !found {
		return "", err
	}
	return formatAppliedSetpointChanges(previous.Setpoints, current.Setpoints), nil
}

func formatAppliedSetpointChanges(before, after domain.Setpoints) string {
	changes := make([]string, 0, 9)
	addFloat := func(label, unit string, old, next float64) {
		if old != next {
			changes = append(changes, fmt.Sprintf("%s %g%s → %g%s", label, old, unit, next, unit))
		}
	}
	addFloat("day temperature", "°C", before.TemperatureDayC, after.TemperatureDayC)
	addFloat("night temperature", "°C", before.TemperatureNightC, after.TemperatureNightC)
	addFloat("humidity low", "%", before.HumidityLowPct, after.HumidityLowPct)
	addFloat("humidity high", "%", before.HumidityHighPct, after.HumidityHighPct)
	addFloat("humidity deadband", "%", before.HumidityDeadbandPct, after.HumidityDeadbandPct)
	if before.CO2TargetPPM != after.CO2TargetPPM {
		changes = append(changes, fmt.Sprintf("CO₂ target %d ppm → %d ppm", before.CO2TargetPPM, after.CO2TargetPPM))
	}
	addFloat("CO₂ vent interlock", "%", before.CO2VentInterlockThresholdPct, after.CO2VentInterlockThresholdPct)
	addFloat("VPD target", " kPa", before.VPDTargetKPa, after.VPDTargetKPa)
	addFloat("DLI target", " mol/m²/day", before.DLITargetMol, after.DLITargetMol)
	return strings.Join(changes, ", ")
}

// currentSetpoints returns the greenhouse's in-force bundle: its current intended revision, or
// the reconciler's controller-seeded baseline when none exists yet.
func (s *Server) currentSetpoints(ctx context.Context, id string) (domain.Setpoints, error) {
	current, found, err := s.store.CurrentRevision(ctx, id)
	if err != nil {
		return domain.Setpoints{}, err
	}
	if found {
		return current.Setpoints, nil
	}
	baseline, err := s.reconcile.Baseline(ctx, id)
	if err != nil {
		if errors.Is(err, reconcile.ErrUnknownGreenhouse) {
			return domain.Setpoints{}, nil
		}
		return domain.Setpoints{}, err
	}
	return baseline, nil
}

// flattenClimateBounds projects a stage's crop-safe envelope onto the flat {field: {min,max}}
// map the diff keys by scalar setpoint field name. It reuses climateBoundFields — the same
// table the optimizer-write bound gate iterates — so the diff and the gate never disagree on
// which fields are bounded. A nil envelope yields an empty (non-nil) map.
func flattenClimateBounds(bounds *domain.StageBounds) map[string]fieldBoundDTO {
	flat := make(map[string]fieldBoundDTO)
	if bounds == nil {
		return flat
	}
	for _, f := range climateBoundFields {
		if b := f.bound(*bounds); b != nil {
			flat[f.name] = fieldBoundDTO{Min: b.Min, Max: b.Max}
		}
	}
	return flat
}

// bearerToken forwards the caller's Authorization header to the optimizer so its own
// operator-role re-check passes in oidc mode; "" on the untokened trusted_network default.
func bearerToken(c echo.Context) string {
	return c.Request().Header.Get(echo.HeaderAuthorization)
}

// optimizerFail maps an optimizer client error onto a response. An operator-meaningful upstream
// status (400 out-of-allowlist model, 404 unknown greenhouse/escalation, 409 disabled / already
// planning, 401/403 role re-check) passes through with its code; a transport failure (the
// optimizer was unreachable, not merely unhappy) is a 502.
func (s *Server) optimizerFail(c echo.Context, err error) error {
	switch code := optimizer.StatusCode(err); code {
	case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusConflict:
		return respondError(c, code, http.StatusText(code))
	default:
		s.log.Warn("optimizer proxy call failed", "uri", c.Request().RequestURI, "err", err)
		return respondError(c, http.StatusBadGateway, "optimizer unavailable")
	}
}
