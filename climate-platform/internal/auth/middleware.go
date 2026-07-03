package auth

import (
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"
)

// contextKey is the echo.Context key under which validated claims are stashed by
// Authenticated for RequireOperator (and handlers) to read.
const contextKey = "auth.claims"

// Authenticated requires a valid bearer token on every request in the group and stashes the
// resulting claims for downstream checks. When the verifier is nil (OIDC not configured) it
// is a pass-through — the unauthenticated 2a posture. The token is read from the
// `Authorization: Bearer` header or, for the WebSocket handshake where a browser cannot set
// headers, from the `access_token` query parameter.
func Authenticated(verifier *Verifier) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if verifier == nil {
				return next(c)
			}
			rawToken := bearerToken(c.Request())
			if rawToken == "" {
				return unauthorized(c, "missing bearer token")
			}
			claims, err := verifier.Verify(c.Request().Context(), rawToken)
			if err != nil {
				return unauthorized(c, "invalid bearer token")
			}
			c.Set(contextKey, claims)
			return next(c)
		}
	}
}

// RequireOperator gates a write route on the operator role. It assumes Authenticated has
// already run (same group), so a missing claim means the token lacked authentication. When
// the verifier is nil it is a pass-through, matching Authenticated.
func RequireOperator(verifier *Verifier) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if verifier == nil {
				return next(c)
			}
			claims, ok := c.Get(contextKey).(*Claims)
			if !ok || claims == nil {
				return unauthorized(c, "missing bearer token")
			}
			if !claims.IsOperator() {
				return forbidden(c, "operator role required")
			}
			return next(c)
		}
	}
}

// ClaimsFrom returns the validated claims for the request, if any (nil in unauthenticated
// mode). Handlers use it for the audit trail (who performed a write).
func ClaimsFrom(c echo.Context) *Claims {
	claims, _ := c.Get(contextKey).(*Claims)
	return claims
}

// bearerToken extracts the raw token from the Authorization header or the access_token query
// parameter (the WebSocket fallback).
func bearerToken(r *http.Request) string {
	if header := r.Header.Get("Authorization"); header != "" {
		if token, ok := strings.CutPrefix(header, "Bearer "); ok {
			return strings.TrimSpace(token)
		}
	}
	return r.URL.Query().Get("access_token")
}

// unauthorized / forbidden render the shared {"error": ...} body (contracts common.json#/Error).
func unauthorized(c echo.Context, msg string) error {
	return c.JSON(http.StatusUnauthorized, map[string]string{"error": msg})
}

func forbidden(c echo.Context, msg string) error {
	return c.JSON(http.StatusForbidden, map[string]string{"error": msg})
}
