package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// ErrAlreadyExists is returned by Register when the greenhouse id is already taken.
var ErrAlreadyExists = errors.New("greenhouse already exists")

// Greenhouse is one registry row.
type Greenhouse struct {
	ID          string
	DisplayName string
	Crop        *string
}

// Endpoint is how the platform reaches a greenhouse's controller.
type Endpoint struct {
	RESTBaseURL   string
	MQTTTopicRoot string
	BearerToken   *string
}

// Registration is the full input to register a greenhouse.
type Registration struct {
	ID          string
	DisplayName string
	Crop        *string
	Endpoint    Endpoint
}

// ListGreenhouses returns every registered greenhouse, ordered by id.
func (s *Store) ListGreenhouses(ctx context.Context) ([]Greenhouse, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, display_name, crop FROM greenhouses ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var greenhouses []Greenhouse
	for rows.Next() {
		var greenhouse Greenhouse
		var crop pgtype.Text
		if err := rows.Scan(&greenhouse.ID, &greenhouse.DisplayName, &crop); err != nil {
			return nil, err
		}
		greenhouse.Crop = textPtr(crop)
		greenhouses = append(greenhouses, greenhouse)
	}
	return greenhouses, rows.Err()
}

// GetGreenhouse returns one greenhouse; found is false when it does not exist.
func (s *Store) GetGreenhouse(ctx context.Context, id string) (greenhouse Greenhouse, found bool, err error) {
	var crop pgtype.Text
	err = s.pool.QueryRow(ctx, `SELECT id, display_name, crop FROM greenhouses WHERE id=$1`, id).
		Scan(&greenhouse.ID, &greenhouse.DisplayName, &crop)
	if errors.Is(err, pgx.ErrNoRows) {
		return Greenhouse{}, false, nil
	}
	if err != nil {
		return Greenhouse{}, false, err
	}
	greenhouse.Crop = textPtr(crop)
	return greenhouse, true, nil
}

// Exists reports whether a greenhouse id is registered.
func (s *Store) Exists(ctx context.Context, id string) (bool, error) {
	var present int
	err := s.pool.QueryRow(ctx, `SELECT 1 FROM greenhouses WHERE id=$1`, id).Scan(&present)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// GetEndpoint returns a greenhouse's controller endpoint; found is false when absent.
func (s *Store) GetEndpoint(ctx context.Context, id string) (endpoint Endpoint, found bool, err error) {
	var token pgtype.Text
	err = s.pool.QueryRow(ctx,
		`SELECT rest_base_url, mqtt_topic_root, bearer_token FROM controller_endpoints WHERE greenhouse_id=$1`, id).
		Scan(&endpoint.RESTBaseURL, &endpoint.MQTTTopicRoot, &token)
	if errors.Is(err, pgx.ErrNoRows) {
		return Endpoint{}, false, nil
	}
	if err != nil {
		return Endpoint{}, false, err
	}
	endpoint.BearerToken = textPtr(token)
	return endpoint, true, nil
}

// ListEndpoints returns every greenhouse's endpoint, keyed by greenhouse id — used to
// bootstrap ingest routing and to fan a fleet-wide control action out to controllers.
func (s *Store) ListEndpoints(ctx context.Context) (map[string]Endpoint, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT greenhouse_id, rest_base_url, mqtt_topic_root, bearer_token FROM controller_endpoints`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	endpoints := make(map[string]Endpoint)
	for rows.Next() {
		var id string
		var endpoint Endpoint
		var token pgtype.Text
		if err := rows.Scan(&id, &endpoint.RESTBaseURL, &endpoint.MQTTTopicRoot, &token); err != nil {
			return nil, err
		}
		endpoint.BearerToken = textPtr(token)
		endpoints[id] = endpoint
	}
	return endpoints, rows.Err()
}

// Register inserts a greenhouse and its controller endpoint in one transaction.
// It returns ErrAlreadyExists if the id is taken.
func (s *Store) Register(ctx context.Context, registration Registration) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // rollback after commit is a no-op

	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM greenhouses WHERE id=$1)`, registration.ID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return ErrAlreadyExists
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO greenhouses (id, display_name, crop) VALUES ($1, $2, $3)`,
		registration.ID, registration.DisplayName, ptrText(registration.Crop)); err != nil {
		return fmt.Errorf("insert greenhouse: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO controller_endpoints (greenhouse_id, rest_base_url, mqtt_topic_root, bearer_token)
		 VALUES ($1, $2, $3, $4)`,
		registration.ID, registration.Endpoint.RESTBaseURL, registration.Endpoint.MQTTTopicRoot, ptrText(registration.Endpoint.BearerToken)); err != nil {
		return fmt.Errorf("insert endpoint: %w", err)
	}
	return tx.Commit(ctx)
}

// Retire deletes a greenhouse (cascading its endpoint). Historical telemetry in the
// hypertables is left intact. found is false when the greenhouse did not exist.
func (s *Store) Retire(ctx context.Context, id string) (found bool, err error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM greenhouses WHERE id=$1`, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func textPtr(text pgtype.Text) *string {
	if !text.Valid {
		return nil
	}
	value := text.String
	return &value
}

func ptrText(ptr *string) pgtype.Text {
	if ptr == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *ptr, Valid: true}
}
