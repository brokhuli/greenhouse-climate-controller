package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ws"
)

// The optimizer→platform outcome-report ingest (optimizer interfaces §Outcome reporting). It is the
// audit twin of the setpoint write (setpoints.go): the optimizer's escalations and run failures are
// not setpoint writes, so they need their own channel to reach the activity feed. Gated by the same
// setpoints:write service seam. An applied plan already surfaces via its write, and an extended cycle
// writes nothing, so the optimizer reports only escalations here.

// runFailureReasons are the escalation reason codes for a cycle that produced no usable plan — an
// infrastructure failure surfaced as optimizer_run_failed. Every other escalation reason is a plan
// held for operator review (optimizer_plan_escalated). Mirrors the frontend emission table
// (spec 05 §Events) and the optimizer's ReasonCode set.
// optimizerOutcomeReportDTO is the optimizer's outcome-report body (dataaccess.report_outcome).
type optimizerOutcomeReportDTO struct {
	OptimizerRunID string  `json:"optimizer_run_id"`
	Status         string  `json:"status"`
	ReasonCode     *string `json:"reason_code"`
	Message        *string `json:"message"`
}

// submitOptimizerOutcome ingests one cycle-outcome report and emits the matching activity-feed event.
// Only an escalation becomes an event; a non-escalated report is accepted as a no-op so the optimizer
// need not special-case which outcomes to send. 202 acknowledges receipt.
func (s *Server) submitOptimizerOutcome(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("id")
	exists, err := s.store.Exists(ctx, id)
	if err != nil {
		return s.fail(c, err)
	}
	if !exists {
		return respondNotFound(c, "greenhouse not found")
	}
	var body optimizerOutcomeReportDTO
	if err := c.Bind(&body); err != nil {
		return respondError(c, http.StatusBadRequest, "invalid JSON body")
	}
	if body.Status == "held" || body.Status == "failed" {
		s.emitEvent(ctx, optimizerOutcomeEvent(id, body))
	}
	return c.NoContent(http.StatusAccepted)
}

// optimizerOutcomeEvent maps an escalation report to its audit event: a run-failure reason becomes
// optimizer_run_failed, any other held reason optimizer_plan_escalated — both warnings, sourced to
// the optimizer, carrying the reason + run id + the cycle's own detail for troubleshooting.
func optimizerOutcomeEvent(greenhouseID string, body optimizerOutcomeReportDTO) domain.Event {
	reason := ""
	if body.ReasonCode != nil {
		reason = *body.ReasonCode
	}
	kind := "optimizer_plan_held"
	if body.Status == "failed" {
		kind = "optimizer_run_failed"
	}
	return domain.Event{
		GreenhouseID: greenhouseID,
		TS:           time.Now().UTC(),
		Kind:         kind,
		Severity:     "warning",
		Message:      optimizerOutcomeMessage(body.Status, reason, body.OptimizerRunID, body.Message),
		Source:       "optimizer",
	}
}

// optimizerOutcomeMessage composes the operator-facing troubleshooting line: the reason code, a short
// run id, and the cycle's recorded detail (e.g. "cycle exceeded cycle_timeout_seconds (240s)").
func optimizerOutcomeMessage(status, reason, runID string, detail *string) string {
	head := reason
	if head == "" {
		head = status
	}
	msg := fmt.Sprintf("optimizer cycle %s: %s (run %s)", status, head, shortRunID(runID))
	if detail != nil && *detail != "" {
		msg += " — " + *detail
	}
	return msg
}

// shortRunID abbreviates an optimizer run id for an operator-facing message (the leading segment of
// the UUID is enough to correlate with the escalation queue / logs).
func shortRunID(runID string) string {
	if len(runID) > 8 {
		return runID[:8]
	}
	return runID
}

// emitEvent persists an activity-feed event and fans it out on the live channel — the Server-level
// analog of reconcile.emitEvent, for the events the optimizer console proxy raises directly.
func (s *Server) emitEvent(ctx context.Context, event domain.Event) {
	if err := s.store.InsertEvent(ctx, event); err != nil {
		s.log.Error("optimizer audit event", "id", event.GreenhouseID, "kind", event.Kind, "err", err)
	}
	s.hub.Broadcast(ws.NewEvent(event))
}
