import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { apiClient } from "../../src/api/client";
import { FLEET_POLL_BASE_MS } from "../../src/api/queries/fleet";
import { useFleet } from "../../src/api/queries/greenhouses";
import { queryKeys } from "../../src/api/queries/keys";
import type { GreenhouseSummary } from "../../src/api/schemas";

// Wire-shaped (pre-Zod) fleet payload — `useFleet` maps it through `toGreenhouseSummary`, so the
// spy on `apiClient.get` must return the snake_case wire shape, not the view model.
const wireFleet = (dli: number) => [
  {
    id: "gh-a",
    display_name: "Greenhouse A",
    crop: "lettuce",
    status: "online",
    drift: false,
    time_scale: null,
    climate: { temperature: 22.4, humidity: 58, co2: 820, dli },
  },
];

const wrapper = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };

describe("useFleet polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // DLI is a backend accumulator with no live WS carrier, so the fleet summary must refetch on an
  // interval to roll it forward — otherwise the tile is frozen until a page reload (the bug).
  it("refetches on the poll interval so DLI advances without a remount", async () => {
    const getSpy = vi
      .spyOn(apiClient, "get")
      .mockResolvedValueOnce(wireFleet(12.6))
      .mockResolvedValue(wireFleet(15));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useFleet(), { wrapper: wrapper(client) });

    // Mount fetch settles with the initial accumulator value.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data?.[0].climate.dli).toBe(12.6);

    // The self-owned interval fires → a fresh fetch surfaces the rolled-forward DLI, same observer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLEET_POLL_BASE_MS + 100);
    });
    expect(result.current.data?.[0].climate.dli).toBe(15);
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  // Regression: the live stream patches this same fleet query via setQueryData on nearly every
  // telemetry frame. With useQuery's built-in `refetchInterval`, each cache write clears and
  // recreates the observer's interval timer, so a sub-60s frame cadence starves it and DLI never
  // refetches (frozen until a page reload). The self-owned interval must survive those writes.
  it("keeps polling DLI while live frames patch the fleet cache under the interval", async () => {
    const getSpy = vi
      .spyOn(apiClient, "get")
      .mockResolvedValueOnce(wireFleet(12.6))
      .mockResolvedValue(wireFleet(15));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useFleet(), { wrapper: wrapper(client) });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data?.[0].climate.dli).toBe(12.6);

    // Advance most of the way to the poll boundary in steps, writing a fresh telemetry value to the
    // fleet query at each one — the exact write pattern that resets useQuery's own refetch timer. A
    // built-in `refetchInterval` would have its 60s tick pushed past this window and skip the refetch.
    for (let step = 0; step < 4; step += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync((FLEET_POLL_BASE_MS - 4000) / 4); // 4 writes across ~56s
      });
      act(() => {
        client.setQueryData<GreenhouseSummary[]>(queryKeys.fleet(), (fleet) =>
          fleet?.map((summary) => ({
            ...summary,
            climate: { ...summary.climate, temperature: 20 + step },
          })),
        );
      });
    }

    // Cross the 60s boundary: the self-owned interval fires despite the intervening cache writes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(result.current.data?.[0].climate.dli).toBe(15);
  });
});
