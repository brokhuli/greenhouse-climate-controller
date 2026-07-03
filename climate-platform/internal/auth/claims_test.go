package auth

import "testing"

func TestClaimsRoles(t *testing.T) {
	operator := &Claims{Roles: []string{"offline_access", KeycloakOperatorRole, "uma_authorization"}}
	if !operator.HasRole(KeycloakOperatorRole) {
		t.Fatal("expected operator role present")
	}
	if !operator.IsOperator() {
		t.Fatal("expected IsOperator true for gh-operator")
	}

	viewer := &Claims{Roles: []string{KeycloakViewerRole}}
	if viewer.IsOperator() {
		t.Fatal("viewer must not be operator")
	}
	if viewer.HasRole(KeycloakOperatorRole) {
		t.Fatal("viewer must not have operator role")
	}

	empty := &Claims{}
	if empty.IsOperator() || empty.HasRole(KeycloakViewerRole) {
		t.Fatal("empty claims should have no roles")
	}
}
