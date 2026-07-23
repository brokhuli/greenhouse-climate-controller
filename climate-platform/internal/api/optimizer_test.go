package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/optimizer"
)

// optimizerServer builds a Server whose optimizer client points at handler, plus an echo
// context/recorder to drive one proxy handler. A nil handler leaves the client pointed at a
// dead address so the transport-failure path can be exercised.
func optimizerServer(t *testing.T, handler http.HandlerFunc) (*Server, echo.Context, *httptest.ResponseRecorder, func()) {
	t.Helper()
	base := "http://127.0.0.1:0" // unroutable; overridden when a handler is supplied
	cleanup := func() {}
	if handler != nil {
		upstream := httptest.NewServer(handler)
		base = upstream.URL
		cleanup = upstream.Close
	}
	s := &Server{
		optimizer:            optimizer.New(base, time.Second),
		optimizerCadenceSecs: 1800,
		log:                  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/optimizer/x", nil)
	ctx := echo.New().NewContext(req, rec)
	return s, ctx, rec, cleanup
}

func strptr(s string) *string { return &s }

func TestGetOptimizerStatusHealthyPassthrough(t *testing.T) {
	s, ctx, rec, cleanup := optimizerServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"healthy","degraded_reason":null,"enabled":true,"read_only_reason":null,"last_successful_cycle_at":"2026-07-22T13:30:00.000Z","escalation_backlog":0,"cadence_secs":1800}`))
	})
	defer cleanup()

	if err := s.getOptimizerStatus(ctx); err != nil {
		t.Fatal(err)
	}
	var got optimizerStatusDTO
	decode(t, rec, &got)
	if got.Status != "healthy" || !got.Enabled || got.CadenceSecs != 1800 {
		t.Fatalf("status not projected: %+v", got)
	}
	if got.LastSuccessfulCycle == nil || *got.LastSuccessfulCycle != "2026-07-22T13:30:00.000Z" {
		t.Fatalf("last cycle wrong: %v", got.LastSuccessfulCycle)
	}
}

func TestGetOptimizerStatusSynthesizesUnavailable(t *testing.T) {
	// No upstream — the client cannot reach the optimizer, so the badge is synthesized rather
	// than surfacing a proxy 5xx, and it still renders 200.
	s, ctx, rec, cleanup := optimizerServer(t, nil)
	defer cleanup()

	if err := s.getOptimizerStatus(ctx); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status must always render 200, got %d", rec.Code)
	}
	var got optimizerStatusDTO
	decode(t, rec, &got)
	if got.Status != "unavailable" || got.Enabled {
		t.Fatalf("expected unavailable+disabled, got %+v", got)
	}
	// Before any successful /health, the cadence falls back to the configured default.
	if got.CadenceSecs != 1800 {
		t.Fatalf("cadence = %d, want the configured 1800", got.CadenceSecs)
	}
}

func TestGetOptimizerStatusUnavailableUsesCachedCadence(t *testing.T) {
	s, ctx, rec, cleanup := optimizerServer(t, nil)
	defer cleanup()
	s.lastOptimizerCadence.Store(900) // a prior /health reported 900s

	if err := s.getOptimizerStatus(ctx); err != nil {
		t.Fatal(err)
	}
	var got optimizerStatusDTO
	decode(t, rec, &got)
	if got.CadenceSecs != 900 {
		t.Fatalf("cadence = %d, want the cached 900", got.CadenceSecs)
	}
}

func TestGetOptimizerFleetMapsFiltersAndOmitsUnplanned(t *testing.T) {
	s, _, _, cleanup := optimizerServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"greenhouses":[
				{"greenhouse_id":"gh-a","enabled":true,"status":"applied","reason_code":null,"created_at":"2026-07-22T13:30:00.000Z","optimizer_run_id":"11111111-1111-1111-1111-111111111111"},
				{"greenhouse_id":"gh-b","enabled":true,"status":"escalated","reason_code":"low_confidence","created_at":"2026-07-22T13:28:00.000Z","optimizer_run_id":"22222222-2222-2222-2222-222222222222"},
				{"greenhouse_id":"gh-z","enabled":true,"status":null,"reason_code":null,"created_at":null,"optimizer_run_id":null}
			],
			"rollup":{"backlog":1,"applied":1,"escalated":1,"extended":0,"oldest_open_escalation_age_seconds":120.7}
		}`))
	})
	defer cleanup()

	// Unfiltered: the never-planned gh-z is omitted so the SPA reads its "No plan" from absence.
	got := fleetVia(t, s, "")
	if len(got.Greenhouses) != 2 {
		t.Fatalf("expected 2 planned greenhouses, got %d: %+v", len(got.Greenhouses), got.Greenhouses)
	}
	if got.Greenhouses[1].ReasonCode == nil || *got.Greenhouses[1].ReasonCode != "low_confidence" {
		t.Fatalf("escalated reason_code lost: %+v", got.Greenhouses[1])
	}
	// The float age is rounded down to the contract's integer seconds.
	if got.Rollup.OldestOpenAgeSec == nil || *got.Rollup.OldestOpenAgeSec != 120 {
		t.Fatalf("oldest age = %v, want 120", got.Rollup.OldestOpenAgeSec)
	}

	// status=escalated narrows to the one held cycle.
	filtered := fleetVia(t, s, "?status=escalated")
	if len(filtered.Greenhouses) != 1 || filtered.Greenhouses[0].GreenhouseID != "gh-b" {
		t.Fatalf("status filter wrong: %+v", filtered.Greenhouses)
	}
}

// fleetVia drives getOptimizerFleet with an optional query string and decodes the response.
func fleetVia(t *testing.T, s *Server, query string) fleetOptimizerSummaryDTO {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/optimizer/fleet"+query, nil)
	if err := s.getOptimizerFleet(echo.New().NewContext(req, rec)); err != nil {
		t.Fatal(err)
	}
	var got fleetOptimizerSummaryDTO
	decode(t, rec, &got)
	return got
}

func TestMapEscalationRenamesFields(t *testing.T) {
	opened := time.Date(2026, 7, 22, 13, 28, 0, 0, time.UTC)
	got := mapEscalation(optimizer.Escalation{
		EscalationID:   "esc-1",
		GreenhouseID:   "gh-b",
		OptimizerRunID: "run-1",
		ReasonCode:     "low_confidence",
		ReasonClass:    "transient",
		OpenedAt:       opened,
		Message:        strptr("confidence 0.62 < 0.80"),
		Resolution:     nil,
	})
	if got.ID != "esc-1" {
		t.Fatalf("escalation_id must map to id, got %q", got.ID)
	}
	if got.CreatedAt != fmtTS(opened) {
		t.Fatalf("opened_at must map to created_at, got %q", got.CreatedAt)
	}
	if got.ReasonClass != "transient" || got.Resolution != nil {
		t.Fatalf("class/resolution wrong: %+v", got)
	}
}

func TestToPlanViewHeldCycleHasNoPlan(t *testing.T) {
	// An escalated pre-planner cycle carries a null plan; the flattened view keeps it null so
	// the handler emits a null diff too.
	view := toPlanView(optimizer.PlanRecord{
		OptimizerRunID: "run-1",
		GreenhouseID:   "gh-b",
		Outcome:        optimizer.Outcome{Status: "escalated", ReasonCode: strptr("input_stale")},
	})
	if view.Plan != nil {
		t.Fatalf("held cycle must flatten to a null plan, got %+v", view.Plan)
	}
	if view.Outcome.Status != "escalated" || view.Outcome.ReasonCode == nil {
		t.Fatalf("outcome not carried: %+v", view.Outcome)
	}
}

func TestToPlanViewCarriesRawPlanBody(t *testing.T) {
	view := toPlanView(optimizer.PlanRecord{
		OptimizerRunID: "run-1",
		GreenhouseID:   "gh-a",
		Backend:        optimizer.Backend{Provider: "ollama", Model: "llama3", PromptVersion: "v1", Role: "primary"},
		Outcome:        optimizer.Outcome{Status: "applied"},
		Plan: &optimizer.Plan{
			Confidence:         0.91,
			Explanation:        "pre-cool",
			ImmediateSetpoints: json.RawMessage(`{"temperature_day_c":22.5}`),
			ObjectiveScores:    json.RawMessage(`{"anticipation":0.9,"coupling":0.7,"efficiency":0.5}`),
		},
	})
	if view.Plan == nil || view.Plan.Confidence != 0.91 {
		t.Fatalf("plan body not carried: %+v", view.Plan)
	}
	if string(view.Plan.ImmediateSetpoints) != `{"temperature_day_c":22.5}` {
		t.Fatalf("immediate_setpoints not passed through verbatim: %s", view.Plan.ImmediateSetpoints)
	}
	if view.Backend.Provider != "ollama" {
		t.Fatalf("backend not converted: %+v", view.Backend)
	}
}

func TestFlattenClimateBounds(t *testing.T) {
	if got := flattenClimateBounds(nil); got == nil || len(got) != 0 {
		t.Fatalf("nil envelope must yield an empty (non-nil) map, got %v", got)
	}
	bounds := &domain.StageBounds{
		TemperatureDayC: &domain.Bound{Min: 18, Max: 28},
		VPDTargetKpa:    &domain.Bound{Min: 0.6, Max: 1.4},
	}
	got := flattenClimateBounds(bounds)
	if len(got) != 2 {
		t.Fatalf("expected 2 bounded fields, got %d: %v", len(got), got)
	}
	// Keyed by the scalar setpoint field name the diff uses.
	if got["temperature_day_c"].Max != 28 || got["vpd_target_kpa"].Min != 0.6 {
		t.Fatalf("bounds flattened wrong: %v", got)
	}
}

func TestOptimizerFailPassesThroughMeaningfulCodes(t *testing.T) {
	s := &Server{log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	cases := map[int]int{
		http.StatusConflict:   http.StatusConflict,   // already planning / disabled
		http.StatusBadRequest: http.StatusBadRequest, // model not allowlisted
		http.StatusNotFound:   http.StatusNotFound,   // unknown greenhouse / escalation
		http.StatusTeapot:     http.StatusBadGateway, // anything else collapses to 502
	}
	for upstream, want := range cases {
		rec := httptest.NewRecorder()
		ctx := echo.New().NewContext(httptest.NewRequest(http.MethodPost, "/x", nil), rec)
		_ = s.optimizerFail(ctx, &optimizer.StatusError{Code: upstream, Body: "x"})
		if rec.Code != want {
			t.Fatalf("upstream %d mapped to %d, want %d", upstream, rec.Code, want)
		}
	}
	// A transport failure (no StatusError) is a 502, not a passthrough.
	rec := httptest.NewRecorder()
	ctx := echo.New().NewContext(httptest.NewRequest(http.MethodPost, "/x", nil), rec)
	_ = s.optimizerFail(ctx, io.ErrUnexpectedEOF)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("transport failure = %d, want 502", rec.Code)
	}
}

func decode(t *testing.T, rec *httptest.ResponseRecorder, out any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
		t.Fatalf("decode response: %v (%s)", err, rec.Body.String())
	}
}

// TestDTOsRoundTripContractExamples decodes each committed platform-dashboard-rest optimizer
// example into the handler's own DTO and re-marshals it, asserting the JSON is identical. This
// pins the Go wire shapes to the versioned contract the SPA consumes: a missing field, an
// unexpected extra, or a renamed/omitempty tag would diverge here.
func TestDTOsRoundTripContractExamples(t *testing.T) {
	const dir = "../../../contracts/platform-dashboard-rest/examples/"
	cases := []struct {
		file string
		dto  any
	}{
		{"optimizer-status.json", &optimizerStatusDTO{}},
		{"optimizer-status.degraded.json", &optimizerStatusDTO{}},
		{"optimizer-fleet.json", &fleetOptimizerSummaryDTO{}},
		{"optimizer-escalation.json", &escalationDTO{}},
		{"optimizer-model.json", &modelStateDTO{}},
		{"optimizer-enabled.json", &enableStateDTO{}},
		{"optimizer-greenhouse-enabled.json", &greenhouseEnableStateDTO{}},
		{"optimizer-plan.json", &optimizerPlanDetailDTO{}},
		{"optimizer-plan.held.json", &optimizerPlanDetailDTO{}},
	}
	for _, tc := range cases {
		t.Run(tc.file, func(t *testing.T) {
			raw, err := os.ReadFile(dir + tc.file)
			if err != nil {
				t.Fatalf("read example: %v", err)
			}
			if err := json.Unmarshal(raw, tc.dto); err != nil {
				t.Fatalf("example does not fit the DTO: %v", err)
			}
			out, err := json.Marshal(tc.dto)
			if err != nil {
				t.Fatal(err)
			}
			var want, got any
			_ = json.Unmarshal(raw, &want)
			_ = json.Unmarshal(out, &got)
			if !reflect.DeepEqual(want, got) {
				t.Fatalf("DTO diverged from contract example\n want: %s\n  got: %s", raw, out)
			}
		})
	}
}
