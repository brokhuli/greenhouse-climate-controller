package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// ListProfiles returns the whole crop-profile library, ordered by id.
func (s *Store) ListProfiles(ctx context.Context) ([]domain.CropProfile, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, name, crop, stages FROM crop_profiles ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var profiles []domain.CropProfile
	for rows.Next() {
		profile, err := scanProfile(rows)
		if err != nil {
			return nil, err
		}
		profiles = append(profiles, profile)
	}
	return profiles, rows.Err()
}

// GetProfile returns one crop profile; found is false when it does not exist.
func (s *Store) GetProfile(ctx context.Context, id string) (domain.CropProfile, bool, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, name, crop, stages FROM crop_profiles WHERE id=$1`, id)
	if err != nil {
		return domain.CropProfile{}, false, err
	}
	defer rows.Close()
	if !rows.Next() {
		return domain.CropProfile{}, false, rows.Err()
	}
	profile, err := scanProfile(rows)
	if err != nil {
		return domain.CropProfile{}, false, err
	}
	return profile, true, nil
}

// CreateProfile inserts a new crop profile. It returns ErrAlreadyExists if the id is taken.
func (s *Store) CreateProfile(ctx context.Context, profile domain.CropProfile) error {
	stages, err := json.Marshal(profile.Stages)
	if err != nil {
		return fmt.Errorf("marshal stages: %w", err)
	}
	_, err = s.pool.Exec(ctx,
		`INSERT INTO crop_profiles (id, name, crop, stages) VALUES ($1,$2,$3,$4)`,
		profile.ID, profile.Name, profile.Crop, string(stages))
	if isUniqueViolation(err) {
		return ErrAlreadyExists
	}
	return err
}

// UpdateProfile replaces a profile's name, crop, and stages. The caller resolves any
// partial (patch) semantics before calling. found is false when the profile is absent.
func (s *Store) UpdateProfile(ctx context.Context, profile domain.CropProfile) (found bool, err error) {
	stages, err := json.Marshal(profile.Stages)
	if err != nil {
		return false, fmt.Errorf("marshal stages: %w", err)
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE crop_profiles SET name=$2, crop=$3, stages=$4, updated_at=now() WHERE id=$1`,
		profile.ID, profile.Name, profile.Crop, string(stages))
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// DeleteProfile removes a profile from the library. It returns ErrProfileInUse when a
// greenhouse is still assigned to it. found is false when the profile did not exist.
func (s *Store) DeleteProfile(ctx context.Context, id string) (found bool, err error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM crop_profiles WHERE id=$1`, id)
	if isForeignKeyViolation(err) {
		return false, ErrProfileInUse
	}
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func scanProfile(rows pgx.Rows) (domain.CropProfile, error) {
	var profile domain.CropProfile
	var stages []byte
	if err := rows.Scan(&profile.ID, &profile.Name, &profile.Crop, &stages); err != nil {
		return domain.CropProfile{}, err
	}
	if err := json.Unmarshal(stages, &profile.Stages); err != nil {
		return domain.CropProfile{}, fmt.Errorf("unmarshal stages for %s: %w", profile.ID, err)
	}
	return profile, nil
}
