// Package auth validates the OIDC bearer tokens issued by Keycloak and maps their
// realm roles onto the platform's two capability roles (viewer / operator). Identity is
// delegated to Keycloak; authorization — which role may call which surface — is enforced
// here (platform security §2). The whole package is a no-op when OIDC is not configured:
// a nil *Verifier means the trusted-network posture of 2a, unauthenticated (RFC-011).
package auth

// Keycloak realm roles. The mapping onto platform capability roles lives here (and only
// here) so the identity provider's role taxonomy can change without touching the
// capability checks scattered across the API (platform security §3).
const (
	// KeycloakOperatorRole grants every write-path action (register/retire, setpoint
	// edits, profile create/edit, assign/reconcile).
	KeycloakOperatorRole = "gh-operator"
	// KeycloakViewerRole grants read-only access; it is the baseline any authenticated
	// user already has, so it is not checked directly.
	KeycloakViewerRole = "gh-viewer"
	// KeycloakSetpointsWriteRole is the narrow service role a Keycloak client-credentials token
	// carries for the optimizer → POST /setpoints boundary (RFC-011). It grants only setpoint
	// submission — not the full operator role (which also registers greenhouses and edits
	// profiles). A service account's realm roles arrive in `realm_access.roles`, the same claim
	// the verifier already reads for human roles.
	KeycloakSetpointsWriteRole = "setpoints:write"
)

// Claims is the subset of a validated access token the platform authorizes on.
type Claims struct {
	// Subject is the token's `sub` — a stable per-user identifier.
	Subject string
	// Username is the human-facing `preferred_username`, for the audit trail.
	Username string
	// Roles are the Keycloak realm roles carried in `realm_access.roles`.
	Roles []string
}

// HasRole reports whether the token carries the given Keycloak realm role.
func (c *Claims) HasRole(role string) bool {
	for _, have := range c.Roles {
		if have == role {
			return true
		}
	}
	return false
}

// IsOperator reports whether the token maps to the platform operator role — the gate on
// every write surface (platform security §4).
func (c *Claims) IsOperator() bool { return c.HasRole(KeycloakOperatorRole) }

// CanWriteSetpoints reports whether the token may submit setpoints on POST /setpoints — either a
// service token carrying the narrow setpoints:write role (the optimizer) or a human operator, who
// holds every write capability (platform security §4). It gates only that one surface; the other
// write endpoints remain operator-only.
func (c *Claims) CanWriteSetpoints() bool {
	return c.HasRole(KeycloakSetpointsWriteRole) || c.IsOperator()
}
