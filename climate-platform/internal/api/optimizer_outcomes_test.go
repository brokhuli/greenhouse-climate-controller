package api

import (
	"strings"
	"testing"
)

const runID = "018f9c2e-6b7a-7c31-9e4d-2a1b5c6d7e8f"

func TestOptimizerOutcomeEventMapsRunFailureReasons(t *testing.T) {
	for _, reason := range []string{"cycle_timeout", "llm_unavailable", "plan_unparseable", "internal_error"} {
		ev := optimizerOutcomeEvent("gh-a", optimizerOutcomeReportDTO{
			OptimizerRunID: runID,
			Status:         "escalated",
			ReasonCode:     strptr(reason),
			Message:        strptr("boom"),
		})
		if ev.Kind != "optimizer_run_failed" {
			t.Fatalf("reason %q → kind %q, want optimizer_run_failed", reason, ev.Kind)
		}
		if ev.Severity != "warning" || ev.Source != "optimizer" {
			t.Fatalf("reason %q → severity/source %q/%q, want warning/optimizer", reason, ev.Severity, ev.Source)
		}
	}
}

func TestOptimizerOutcomeEventMapsHeldReasonsToEscalated(t *testing.T) {
	ev := optimizerOutcomeEvent("gh-a", optimizerOutcomeReportDTO{
		OptimizerRunID: runID,
		Status:         "escalated",
		ReasonCode:     strptr("low_confidence"),
		Message:        strptr("confidence 0.42 below threshold"),
	})
	if ev.Kind != "optimizer_plan_escalated" {
		t.Fatalf("kind = %q, want optimizer_plan_escalated", ev.Kind)
	}
	// The message carries the reason, the short run id, and the cycle's own troubleshooting detail.
	for _, want := range []string{"low_confidence", "018f9c2e", "confidence 0.42 below threshold"} {
		if !strings.Contains(ev.Message, want) {
			t.Fatalf("message %q missing %q", ev.Message, want)
		}
	}
}

func TestOptimizerOutcomeMessageWithoutDetail(t *testing.T) {
	// A report with no detail still names the reason and the run — no dangling separator.
	msg := optimizerOutcomeMessage("cycle_timeout", runID, nil)
	if !strings.Contains(msg, "cycle_timeout") || !strings.Contains(msg, "018f9c2e") {
		t.Fatalf("message = %q, want reason + short run id", msg)
	}
	if strings.Contains(msg, "—") {
		t.Fatalf("message = %q, want no detail separator when detail is absent", msg)
	}
}
