package domain

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"testing"
)

// The metric / unit / actuator vocabulary is hand-mirrored in three places: the governing contract
// (contracts/platform-dashboard-live-ws/common.schema.json, the source of truth), this domain
// package, and the frontend's Zod schemas. When the backend mirror drifts — e.g. a metric added to
// the contract but not to domain.Metrics — decode.go silently drops that reading before broadcast
// and every chart + stat card freezes while actuators keep working. These tests fail the build the
// moment domain drifts from the contract, so the regression is caught on the PR instead of at
// runtime. The frontend has the matching mirror test (climate-frontend contractParity.test.ts).
//
// Go runs each package's tests with the working directory set to the package source dir, so this
// relative path to the repo-root contracts/ tree is stable regardless of where `go test` is invoked.
const commonSchemaPath = "../../../contracts/platform-dashboard-live-ws/common.schema.json"

type enumDef struct {
	Enum []string `json:"enum"`
}

// bindingClause is one `if metric == X then unit == Y` clause of the contract reading's allOf.
type bindingClause struct {
	If struct {
		Properties struct {
			Metric struct {
				Const string `json:"const"`
			} `json:"metric"`
		} `json:"properties"`
	} `json:"if"`
	Then struct {
		Properties struct {
			Unit struct {
				Const string `json:"const"`
			} `json:"unit"`
		} `json:"properties"`
	} `json:"then"`
}

type commonSchema struct {
	Defs struct {
		Metric       enumDef `json:"metric"`
		Unit         enumDef `json:"unit"`
		ActuatorName enumDef `json:"actuator_name"`
		Reading      struct {
			AllOf []bindingClause `json:"allOf"`
		} `json:"reading"`
	} `json:"$defs"`
}

func loadCommonSchema(t *testing.T) commonSchema {
	t.Helper()
	data, err := os.ReadFile(filepath.FromSlash(commonSchemaPath))
	if err != nil {
		t.Fatalf("read contract schema: %v", err)
	}
	var schema commonSchema
	if err := json.Unmarshal(data, &schema); err != nil {
		t.Fatalf("parse contract schema: %v", err)
	}
	return schema
}

// sortedKeys returns the keys of a closed-set map sorted, for order-independent comparison.
func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestMetricsMatchContract(t *testing.T) {
	want := slices.Clone(loadCommonSchema(t).Defs.Metric.Enum)
	sort.Strings(want)
	got := sortedKeys(Metrics)
	if !slices.Equal(got, want) {
		t.Fatalf("domain.Metrics drifted from contract $defs.metric:\n  domain:   %v\n  contract: %v", got, want)
	}
}

func TestActuatorsMatchContract(t *testing.T) {
	want := slices.Clone(loadCommonSchema(t).Defs.ActuatorName.Enum)
	sort.Strings(want)
	got := sortedKeys(Actuators)
	if !slices.Equal(got, want) {
		t.Fatalf("domain.Actuators drifted from contract $defs.actuator_name:\n  domain:   %v\n  contract: %v", got, want)
	}
}

func TestMetricUnitBindingMatchesContract(t *testing.T) {
	schema := loadCommonSchema(t)

	// The contract's metric→unit binding, read from the reading.allOf if/then clauses.
	contract := make(map[string]string, len(schema.Defs.Reading.AllOf))
	for _, clause := range schema.Defs.Reading.AllOf {
		contract[clause.If.Properties.Metric.Const] = clause.Then.Properties.Unit.Const
	}

	if len(metricUnits) != len(contract) {
		t.Fatalf("metricUnits binds %d metrics, contract binds %d", len(metricUnits), len(contract))
	}
	for metric, unit := range contract {
		if got := MetricUnit(metric); got != unit {
			t.Errorf("metric %q: domain unit %q, contract unit %q", metric, got, unit)
		}
	}
	// Reverse direction: no stray metric bound in domain that the contract doesn't.
	for metric := range metricUnits {
		if _, ok := contract[metric]; !ok {
			t.Errorf("metric %q in metricUnits is not bound by the contract", metric)
		}
	}
	// Every unit the contract binds must live in its own $defs.unit enum (fixture self-consistency).
	units := make(map[string]bool, len(schema.Defs.Unit.Enum))
	for _, u := range schema.Defs.Unit.Enum {
		units[u] = true
	}
	for metric, unit := range contract {
		if !units[unit] {
			t.Errorf("contract binds metric %q to unit %q, absent from $defs.unit enum", metric, unit)
		}
	}
}
