package api

import "testing"

func TestControllerPath(t *testing.T) {
	cases := []struct {
		id, resource, want string
	}{
		{"gh-a", "/setpoints", "/greenhouses/gh-a/setpoints"},
		{"gh-b", "/sim/time-scale", "/greenhouses/gh-b/sim/time-scale"},
	}
	for _, tc := range cases {
		if got := controllerPath(tc.id, tc.resource); got != tc.want {
			t.Errorf("controllerPath(%q, %q) = %q, want %q", tc.id, tc.resource, got, tc.want)
		}
	}
}
