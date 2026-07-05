package auth

import (
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"
)

// contextKey is the echo.Context key under which validated claims are stashed by
// Authenticated for RequireOperator (and handlers) to read.
const contextKey = "auth.claims"

// OptionalAuth validates a bearer token when one is present and stashes the resulting claims
// for downstream checks, but lets a token-less request through as an anonymous viewer — reads
// are open to anyone; writes are gated separately by RequireOperator. A present-but-invalid
// token is still rejected with 401 so an expired operator session re-authenticates cleanly
// rather than silently dropping to read-only. When the verifier is nil (OIDC not configured)
// it is a pass-through — the unauthenticated 2a posture. The token is read from the
// `Authorization: Bearer` header or, for the WebSocket handshake where a browser cannot set
// headers, from the `access_token` query parameter.
func OptionalAuth(verifier *Verifier) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if verifier == nil {
				return next(c)
			}
			rawToken := bearerToken(c.Request())
			if rawToken == "" {
				return next(c) // anonymous viewer — no claims stashed
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

// RequireOperator gates a write route on the operator role. It assumes OptionalAuth has
// already run (same group), so a missing claim means the request is anonymous (no token) —
// answered with 401 so the caller knows to sign in. When the verifier is nil it is a
// pass-through, matching OptionalAuth.
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

// RequireSetpointsWrite gates the optimizer → POST /setpoints boundary (RFC-011). It assumes
// OptionalAuth has already run (same group). Enforcement is dormant by default and only kicks in
// when enforce is true (SERVICE_AUTH_MODE=oidc):
//
//   - verifier == nil (OIDC not configured) → pass-through, the 2a unauthenticated posture.
//   - enforce == false (SERVICE_AUTH_MODE=trusted_network) → pass-through: the service plane is
//     trusted on the local network by default, independently of human auth being on.
//   - enforce == true → a token is required (401 if absent) carrying setpoints:write or the
//     operator role (403 otherwise).
func RequireSetpointsWrite(verifier *Verifier, enforce bool) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if verifier == nil || !enforce {
				return next(c)
			}
			claims, ok := c.Get(contextKey).(*Claims)
			if !ok || claims == nil {
				return unauthorized(c, "missing bearer token")
			}
			if !claims.CanWriteSetpoints() {
				return forbidden(c, "setpoints:write or operator role required")
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
