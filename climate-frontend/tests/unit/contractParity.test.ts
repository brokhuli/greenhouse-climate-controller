import { describe, expect, it } from "vitest";
import {
  METRIC_UNIT,
  actuatorNameSchema,
  metricSchema,
  telemetryFrame,
  unitSchema,
} from "../../src/api/schemas";
import { wsSchema } from "../fixtures";

/**
 * Binds the frontend's live-telemetry Zod schemas to the governing contract
 * (contracts/platform-dashboard-live-ws/common.schema.json). The metric/unit/actuator enums and the
 * metric→unit binding are hand-mirrored in three places — this contract (source of truth), the Go
 * backend's `domain` maps, and `src/api/schemas.ts`. When the frontend mirror drifts, reading frames
 * fail the strict Zod parse and every chart + stat card silently freezes while actuators (a separate
 * telemetry frame carrying `readings:[]`) keep working. This test fails the build the moment the
 * frontend mirror drifts from the contract, so the regression is caught on the PR instead of at
 * runtime. The backend has the matching mirror test in climate-platform (domain.contract_parity).
 */

type EnumDef = { enum: string[] };
type BindingClause = {
  if: { properties: { metric: { const: string } } };
  then: { properties: { unit: { const: string } } };
};
type Common = {
  $defs: {
    metric: EnumDef;
    unit: EnumDef;
    actuator_name: EnumDef;
    reading: { allOf: BindingClause[] };
  };
};

const defs = (wsSchema("common.schema.json") as Common).$defs;
const sorted = (values: readonly string[]): string[] => [...values].sort();

/** The contract's metric→unit binding, read from the `reading.allOf` if/then clauses. */
const contractBinding: Record<string, string> = Object.fromEntries(
  defs.reading.allOf.map((clause) => [
    clause.if.properties.metric.const,
    clause.then.properties.unit.const,
  ]),
);

describe("live-telemetry schema ⇄ contract parity", () => {
  it("metric enum matches the contract", () => {
    expect(sorted(metricSchema.options)).toEqual(sorted(defs.metric.enum));
  });

  it("unit enum matches the contract", () => {
    expect(sorted(unitSchema.options)).toEqual(sorted(defs.unit.enum));
  });

  it("actuator-name enum matches the contract", () => {
    expect(sorted(actuatorNameSchema.options)).toEqual(sorted(defs.actuator_name.enum));
  });

  it("METRIC_UNIT matches the contract's metric→unit binding", () => {
    expect(METRIC_UNIT).toEqual(contractBinding);
  });

  // The committed telemetry.json example only covers `temperature`; exercise the whole metric enum so
  // a metric that exists in both the contract and the Zod enum but is mis-bound (wrong unit / missing
  // METRIC_UNIT row, which trips `wsReading`'s metric↔unit superRefine) is still caught here.
  it("accepts a canonical telemetry frame for every contract metric", () => {
    for (const metric of defs.metric.enum) {
      const parsed = telemetryFrame.safeParse({
        schema_version: 1,
        greenhouse_id: "gh-a",
        zone_id: null,
        ts: "2026-06-17T00:00:00.000Z",
        type: "telemetry",
        readings: [{ metric, value: 1, unit: contractBinding[metric] }],
      });
      expect(parsed.success, `contract metric "${metric}" should parse`).toBe(true);
    }
  });
});
