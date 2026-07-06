//go:build integration

package test

import (
	"context"
	"testing"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
)

// TestJobStats verifies the datastore job-health query sees the TimescaleDB background
// jobs the platform registers at startup: the three telemetry retention policies
// (EnsureTimescale) and the provenance-prune job (EnsureProvenancePrune). These feed the
// platform_bgjob_* metrics (operations §1, datastore job health).
func TestJobStats(t *testing.T) {
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

	stats, err := st.JobStats(ctx)
	if err != nil {
		t.Fatalf("job stats: %v", err)
	}
	counts := map[string]int{}
	for _, js := range stats {
		counts[js.Name]++
		if js.JobID == 0 {
			t.Errorf("job %q has zero id", js.Name)
		}
	}
	if counts["prune_setpoint_revisions"] != 1 {
		t.Errorf("prune jobs = %d, want 1 (stats=%+v)", counts["prune_setpoint_revisions"], stats)
	}
	// One retention policy per hypertable: sensor_readings, actuator_states, events.
	if counts["policy_retention"] != 3 {
		t.Errorf("retention jobs = %d, want 3 (stats=%+v)", counts["policy_retention"], stats)
	}
}
