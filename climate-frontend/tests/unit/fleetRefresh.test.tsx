import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { apiClient } from "../../src/api/client";
import { FLEET_POLL_BASE_MS } from "../../src/api/queries/fleet";
import { useFleet } from "../../src/api/queries/greenhouses";

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
    // `refetchIntervalInBackground` because jsdom reports the test window as unfocused, which
    // otherwise gates the interval off (the default, and the right behavior for a real backgrounded
    // tab). A real focused browser tab polls without it.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchIntervalInBackground: true } },
    });

    const { result } = renderHook(() => useFleet(), { wrapper: wrapper(client) });

    // Mount fetch settles with the initial accumulator value.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data?.[0].climate.dli).toBe(12.6);

    // The interval fires → a fresh fetch surfaces the rolled-forward DLI, same mounted observer.
    // Margin past the exact boundary: the interval anchors a few virtual-ms after mount settles.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLEET_POLL_BASE_MS + 100);
    });
    expect(result.current.data?.[0].climate.dli).toBe(15);
    expect(getSpy).toHaveBeenCalledTimes(2);
  });
});
