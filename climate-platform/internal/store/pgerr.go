package store

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

// ErrProfileInUse is returned by DeleteProfile when a greenhouse is still assigned to the
// profile (the assignment foreign key is ON DELETE RESTRICT).
var ErrProfileInUse = errors.New("crop profile is assigned to a greenhouse")

// PostgreSQL SQLSTATE codes the store translates into typed errors.
const (
	pgUniqueViolation     = "23505"
	pgForeignKeyViolation = "23503"
)

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation
}

func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == pgForeignKeyViolation
}
