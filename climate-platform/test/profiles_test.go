//go:build integration

package test

import (
	"context"
	"testing"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
)

func sampleSetpoints() domain.Setpoints {
	return domain.Setpoints{
		TemperatureDayC: 24, TemperatureNightC: 18,
		DayStart: "06:00", DayEnd: "20:00",
		HumidityLowPct: 55, HumidityHighPct: 80, HumidityDeadbandPct: 5,
		CO2TargetPPM: 900, CO2VentInterlockThresholdPct: 20,
		VPDTargetKPa: 1.0, DLITargetMol: 17,
		Zones: []domain.ZoneTargets{
			{ZoneID: "bench-a", MoistureLowThreshold: 0.3, MoistureHighThreshold: 0.6, DrainPeriodSecs: 600, Schedule: "06:00,14:00"},
		},
	}
}

// TestProfilesReconciliationState exercises the 2b relational surface end to end against a
// real TimescaleDB: profile CRUD, assignment, the append-only revision ledger, the
// reconciliation-state upsert, and the provenance prune (keeps latest, drops superseded).
func TestProfilesReconciliationState(t *testing.T) {
	ctx := context.Background()
	dsn := newTimescale(t)

	if err := store.Migrate(dsn); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	st, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer st.Close()
	if err := st.EnsureTimescale(ctx, 30); err != nil {
		t.Fatalf("ensure timescale: %v", err)
	}
	if err := st.EnsureProvenancePrune(ctx, 30); err != nil {
		t.Fatalf("ensure prune: %v", err)
	}

	if err := st.Register(ctx, store.Registration{ID: "gh-a", DisplayName: "House A",
		Endpoint: store.Endpoint{RESTBaseURL: "http://gh-a:8080", MQTTTopicRoot: "gh/gh-a"}}); err != nil {
		t.Fatalf("register: %v", err)
	}

	targets := sampleSetpoints()
	profile := domain.CropProfile{ID: "lettuce", Name: "Lettuce", Crop: "lettuce",
		Stages: []domain.ProfileStage{
			{Stage: "propagation", Targets: targets},
			{Stage: "vegetative", Targets: targets},
		}}
	if err := st.CreateProfile(ctx, profile); err != nil {
		t.Fatalf("create profile: %v", err)
	}
	if err := st.CreateProfile(ctx, profile); err != store.ErrAlreadyExists {
		t.Fatalf("duplicate profile err=%v want ErrAlreadyExists", err)
	}

	got, found, err := st.GetProfile(ctx, "lettuce")
	if err != nil || !found {
		t.Fatalf("get profile found=%v err=%v", found, err)
	}
	if len(got.Stages) != 2 || !got.Stages[0].Targets.Equal(targets) {
		t.Fatalf("profile round-trip mismatch: %+v", got)
	}

	// Update: rename and drop to a single stage.
	got.Name = "Lettuce v2"
	got.Stages = got.Stages[:1]
	if ok, err := st.UpdateProfile(ctx, got); err != nil || !ok {
		t.Fatalf("update profile ok=%v err=%v", ok, err)
	}

	// Assignment.
	if err := st.SetAssignment(ctx, domain.Assignment{GreenhouseID: "gh-a", ProfileID: "lettuce", Stage: "propagation"}); err != nil {
		t.Fatalf("set assignment: %v", err)
	}
	assignment, found, err := st.GetAssignment(ctx, "gh-a")
	if err != nil || !found || assignment.ProfileID != "lettuce" || assignment.Stage != "propagation" {
		t.Fatalf("get assignment=%+v found=%v err=%v", assignment, found, err)
	}

	// A profile with a live assignment cannot be deleted.
	if _, err := st.DeleteProfile(ctx, "lettuce"); err != store.ErrProfileInUse {
		t.Fatalf("delete in-use profile err=%v want ErrProfileInUse", err)
	}

	// Intended-state revisions are monotonic per greenhouse; the latest is current.
	rev1, err := st.AppendRevision(ctx, domain.SetpointRevision{GreenhouseID: "gh-a",
		Source: domain.SourceProfile, Actor: "operator", Reason: "assign lettuce", Setpoints: targets})
	if err != nil || rev1 != 1 {
		t.Fatalf("append rev1=%d err=%v", rev1, err)
	}
	edited := targets
	edited.TemperatureDayC = 25
	rev2, err := st.AppendRevision(ctx, domain.SetpointRevision{GreenhouseID: "gh-a",
		Source: domain.SourceOperatorEdit, Actor: "operator", Reason: "warmer day", Setpoints: edited})
	if err != nil || rev2 != 2 {
		t.Fatalf("append rev2=%d err=%v", rev2, err)
	}

	current, found, err := st.CurrentRevision(ctx, "gh-a")
	if err != nil || !found || current.Revision != 2 || current.Source != domain.SourceOperatorEdit || !current.Setpoints.Equal(edited) {
		t.Fatalf("current revision=%+v found=%v err=%v", current, found, err)
	}

	// Reconciliation bookkeeping upserts and reads back.
	delivered := current.Revision
	if err := st.UpsertReconState(ctx, store.ReconState{GreenhouseID: "gh-a",
		LastDeliveredRevision: &delivered, DeliveryStatus: store.DeliveryDelivered}); err != nil {
		t.Fatalf("upsert recon: %v", err)
	}
	recon, found, err := st.GetReconState(ctx, "gh-a")
	if err != nil || !found || recon.LastDeliveredRevision == nil || *recon.LastDeliveredRevision != 2 ||
		recon.DeliveryStatus != store.DeliveryDelivered {
		t.Fatalf("recon=%+v found=%v err=%v", recon, found, err)
	}

	// Prune drops superseded revisions and keeps the current one. A negative window forces the
	// age threshold into the future so the just-written rows qualify.
	if _, err := st.Pool().Exec(ctx, `CALL prune_setpoint_revisions(0, '{"window_days": -1}'::jsonb)`); err != nil {
		t.Fatalf("call prune: %v", err)
	}
	var remaining int
	if err := st.Pool().QueryRow(ctx,
		`SELECT count(*) FROM setpoint_revisions WHERE greenhouse_id='gh-a'`).Scan(&remaining); err != nil {
		t.Fatalf("count revisions: %v", err)
	}
	if remaining != 1 {
		t.Fatalf("after prune remaining=%d want 1", remaining)
	}
	current, found, err = st.CurrentRevision(ctx, "gh-a")
	if err != nil || !found || current.Revision != 2 {
		t.Fatalf("post-prune current=%+v found=%v err=%v", current, found, err)
	}
}
