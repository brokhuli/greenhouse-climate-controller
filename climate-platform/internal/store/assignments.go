package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// GetAssignment returns a greenhouse's current profile/stage assignment; found is false
// when the greenhouse has none.
func (s *Store) GetAssignment(ctx context.Context, greenhouseID string) (domain.Assignment, bool, error) {
	var assignment domain.Assignment
	err := s.pool.QueryRow(ctx,
		`SELECT greenhouse_id, profile_id, stage FROM profile_assignments WHERE greenhouse_id=$1`, greenhouseID).
		Scan(&assignment.GreenhouseID, &assignment.ProfileID, &assignment.Stage)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Assignment{}, false, nil
	}
	if err != nil {
		return domain.Assignment{}, false, err
	}
	return assignment, true, nil
}

// SetAssignment upserts a greenhouse's active assignment (one per greenhouse). An unknown
// profile_id surfaces as a foreign-key error; callers validate the profile first.
func (s *Store) SetAssignment(ctx context.Context, assignment domain.Assignment) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO profile_assignments (greenhouse_id, profile_id, stage, assigned_at)
		 VALUES ($1,$2,$3, now())
		 ON CONFLICT (greenhouse_id)
		 DO UPDATE SET profile_id=EXCLUDED.profile_id, stage=EXCLUDED.stage, assigned_at=now()`,
		assignment.GreenhouseID, assignment.ProfileID, assignment.Stage)
	return err
}
