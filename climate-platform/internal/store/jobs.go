package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// JobStat is the health of one TimescaleDB background job — the telemetry retention
// policies (proc_name policy_retention, one per hypertable) and the provenance-prune job
// (prune_setpoint_revisions, from EnsureProvenancePrune). Reading TimescaleDB's own job
// bookkeeping is the only way to observe these: they run inside the database, not in Go.
type JobStat struct {
	Name           string
	JobID          int64
	LastSuccess    *time.Time
	TotalFailures  int64
	LastRunSuccess bool
}

// JobStats reports the platform's TimescaleDB background-job health so a stalled or
// failing maintenance job (retention, provenance prune) is observable rather than silent
// (operations §1, datastore job health). A job with no run yet has a nil LastSuccess.
func (s *Store) JobStats(ctx context.Context) ([]JobStat, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT j.job_id, j.proc_name, js.last_successful_finish,
		       COALESCE(js.total_failures, 0), js.last_run_status
		FROM timescaledb_information.jobs j
		LEFT JOIN timescaledb_information.job_stats js USING (job_id)
		WHERE j.proc_name IN ('prune_setpoint_revisions', 'policy_retention')
		ORDER BY j.job_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var stats []JobStat
	for rows.Next() {
		var (
			job     JobStat
			finish  pgtype.Timestamptz
			lastRun pgtype.Text
		)
		if err := rows.Scan(&job.JobID, &job.Name, &finish, &job.TotalFailures, &lastRun); err != nil {
			return nil, err
		}
		// last_successful_finish is '-infinity' until the first success; treat only a
		// finite timestamp as a real last-success time.
		if finish.Valid && finish.InfinityModifier == pgtype.Finite {
			t := finish.Time
			job.LastSuccess = &t
		}
		job.LastRunSuccess = lastRun.Valid && lastRun.String == "Success"
		stats = append(stats, job)
	}
	return stats, rows.Err()
}
