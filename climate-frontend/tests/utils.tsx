import type { ReactElement, ReactNode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { StreamProvider } from "../src/app/StreamProvider";
import { ToastProvider } from "../src/components/ui/ToastProvider";
import { ThemeProvider } from "../src/hooks/ThemeProvider";
import { RoleContext, type AuthState, type PlatformRole } from "../src/hooks/useRole";
import type {
  Escalation,
  EventEntry,
  FleetOptimizerGreenhouse,
  FleetOptimizerSummary,
  GreenhouseDetail,
  GreenhouseSummary,
  ModelState,
  OptimizerPlanDetail,
  OptimizerStatus,
  Setpoints,
  ZoneStatus,
} from "../src/api/schemas";

/** A QueryClient that never retries or garbage-collects mid-test. */
export function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
}

/** Build an auth state for a given role (used to render as viewer/operator in tests). */
export function roleState(role: PlatformRole): AuthState {
  return {
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    role,
    isOperator: role === "operator",
    username: role,
    signIn: () => {},
    signOut: () => {},
  };
}

/**
 * Render under the full provider stack (query cache, theme, toasts, the live stream, and a memory
 * router). Seed the cache before rendering so view containers resolve without the network. Pass
 * `role` to render as a viewer/operator; omitting it uses the open-operator default (auth disabled),
 * matching the unauthenticated posture existing tests assume.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: { client?: QueryClient; route?: string; role?: PlatformRole } = {},
) {
  const client = options.client ?? makeClient();
  const wrapper = ({ children }: { children: ReactNode }) => {
    const routed = <MemoryRouter initialEntries={[options.route ?? "/"]}>{children}</MemoryRouter>;
    return (
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <ToastProvider>
            <StreamProvider>
              {options.role ? (
                <RoleContext.Provider value={roleState(options.role)}>
                  {routed}
                </RoleContext.Provider>
              ) : (
                routed
              )}
            </StreamProvider>
          </ToastProvider>
        </ThemeProvider>
      </QueryClientProvider>
    );
  };
  return { client, ...render(ui, { wrapper }) };
}

// ---------------------------------------------------------------------------
// View-model fixtures
// ---------------------------------------------------------------------------

export const sampleSetpoints = (overrides: Partial<Setpoints> = {}): Setpoints => ({
  temperatureDayC: 24,
  temperatureNightC: 18,
  dayStart: "06:00",
  dayEnd: "20:00",
  humidityLowPct: 55,
  humidityHighPct: 75,
  humidityDeadbandPct: 5,
  co2TargetPpm: 900,
  co2VentInterlockThresholdPct: 60,
  vpdTargetKpa: 1.1,
  dliTargetMol: 17,
  zones: [
    {
      zoneId: "bench-a",
      moistureLowThreshold: 0.3,
      moistureHighThreshold: 0.6,
      drainPeriodSecs: 120,
      schedule: "06:00,14:00",
    },
  ],
  ...overrides,
});

export const sampleSummary = (overrides: Partial<GreenhouseSummary> = {}): GreenhouseSummary => ({
  id: "gh-a",
  displayName: "Greenhouse A",
  crop: "lettuce",
  status: "online",
  drift: false,
  timeScale: null,
  climate: { temperature: 22.4, humidity: 58, co2: 820, dli: 12.6 },
  ...overrides,
});

export const sampleZoneStatus = (overrides: Partial<ZoneStatus> = {}): ZoneStatus => ({
  zoneId: "bench-a",
  soilMoistureVwc: 0.41,
  irrigating: false,
  faulted: false,
  lastCycleTs: new Date("2026-06-29T08:00:00.000Z"),
  ...overrides,
});

export const sampleDetail = (overrides: Partial<GreenhouseDetail> = {}): GreenhouseDetail => ({
  id: "gh-a",
  displayName: "Greenhouse A",
  crop: "lettuce",
  status: "online",
  drift: false,
  timeScale: null,
  setpoints: sampleSetpoints(),
  zoneStatus: [sampleZoneStatus()],
  ...overrides,
});

export const sampleEvent = (overrides: Partial<EventEntry> = {}): EventEntry => ({
  greenhouseId: "gh-a",
  ts: new Date("2026-06-24T14:03:00.000Z"),
  kind: "setpoint_edit",
  severity: "info",
  message: "setpoint edit applied",
  source: "operator",
  ...overrides,
});

// --- Optimizer console (3) view-model fixtures ----------------------------------------------

export const sampleOptimizerStatus = (
  overrides: Partial<OptimizerStatus> = {},
): OptimizerStatus => ({
  status: "healthy",
  degradedReason: null,
  enabled: true,
  readOnlyReason: null,
  lastSuccessfulCycleAt: new Date("2026-06-29T13:30:00.000Z"),
  cadenceSecs: 1800,
  ...overrides,
});

export const sampleFleetOptimizerGreenhouse = (
  overrides: Partial<FleetOptimizerGreenhouse> = {},
): FleetOptimizerGreenhouse => ({
  greenhouseId: "gh-a",
  status: "applied",
  reasonCode: null,
  enabled: true,
  createdAt: new Date("2026-06-29T13:30:00.000Z"),
  ...overrides,
});

export const sampleFleetOptimizerSummary = (
  overrides: Partial<FleetOptimizerSummary> = {},
): FleetOptimizerSummary => ({
  greenhouses: [sampleFleetOptimizerGreenhouse()],
  rollup: {
    backlog: 0,
    byOutcome: { applied: 1, escalated: 0, extended: 0 },
    oldestOpenAgeSecs: null,
  },
  ...overrides,
});

export const sampleEscalation = (overrides: Partial<Escalation> = {}): Escalation => ({
  id: "esc-1",
  greenhouseId: "gh-b",
  optimizerRunId: "run-1",
  reasonCode: "low_confidence",
  reasonClass: "transient",
  createdAt: new Date("2026-06-29T13:28:00.000Z"),
  message: "confidence 0.62 < threshold 0.80",
  resolution: null,
  ...overrides,
});

export const sampleModelState = (overrides: Partial<ModelState> = {}): ModelState => ({
  provider: "ollama",
  model: "qwen2.5:7b",
  promptVersion: "v1",
  role: "primary",
  availableModels: ["llama3.2", "qwen2.5:7b", "mistral"],
  ...overrides,
});

export const sampleOptimizerPlanDetail = (
  overrides: Partial<OptimizerPlanDetail> = {},
): OptimizerPlanDetail => ({
  plan: {
    optimizerRunId: "run-1",
    greenhouseId: "gh-a",
    createdAt: new Date("2026-06-29T13:30:00.000Z"),
    horizon: {
      start: new Date("2026-06-29T13:30:00.000Z"),
      end: new Date("2026-06-30T01:30:00.000Z"),
    },
    backend: { provider: "ollama", model: "llama3", promptVersion: "v1", role: "primary" },
    outcome: { status: "applied", reasonCode: null, message: null },
    plan: {
      confidence: 0.91,
      explanation: "Pre-cool ahead of the solar peak.",
      immediateSetpoints: { temperatureDayC: 22.5, vpdTargetKpa: 1.05 },
      objectiveScores: { anticipation: 0.9, coupling: 0.7, efficiency: 0.5 },
    },
  },
  diff: {
    proposed: { temperatureDayC: 22.5, vpdTargetKpa: 1.05 },
    current: sampleSetpoints({ temperatureDayC: 24, vpdTargetKpa: 1.0 }),
    bounds: {
      temperature_day_c: { min: 18, max: 28 },
      vpd_target_kpa: { min: 0.6, max: 1.4 },
    },
  },
  ...overrides,
});
