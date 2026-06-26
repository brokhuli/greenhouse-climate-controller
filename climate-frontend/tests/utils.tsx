import type { ReactElement, ReactNode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { StreamProvider } from "../src/app/StreamProvider";
import { ToastProvider } from "../src/components/ui/ToastProvider";
import { ThemeProvider } from "../src/hooks/ThemeProvider";
import type {
  EventEntry,
  GreenhouseDetail,
  GreenhouseSummary,
  Setpoints,
} from "../src/api/schemas";

/** A QueryClient that never retries or garbage-collects mid-test. */
export function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
}

/**
 * Render under the full provider stack (query cache, theme, toasts, the live stream, and a memory
 * router). Seed the cache before rendering so view containers resolve without the network.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: { client?: QueryClient; route?: string } = {},
) {
  const client = options.client ?? makeClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <ToastProvider>
          <StreamProvider>
            <MemoryRouter initialEntries={[options.route ?? "/"]}>{children}</MemoryRouter>
          </StreamProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
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
  climate: { temperature: 22.4, humidity: 58, setpointTemperature: 24 },
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
