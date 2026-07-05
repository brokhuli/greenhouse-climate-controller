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

func TestCanWriteSetpoints(t *testing.T) {
	service := &Claims{Roles: []string{KeycloakSetpointsWriteRole}}
	if !service.CanWriteSetpoints() {
		t.Fatal("setpoints:write token should be allowed to write setpoints")
	}
	if service.IsOperator() {
		t.Fatal("the service role must not grant the full operator role")
	}

	operator := &Claims{Roles: []string{KeycloakOperatorRole}}
	if !operator.CanWriteSetpoints() {
		t.Fatal("operator should be allowed to write setpoints")
	}

	viewer := &Claims{Roles: []string{KeycloakViewerRole}}
	if viewer.CanWriteSetpoints() {
		t.Fatal("viewer must not be allowed to write setpoints")
	}
}
