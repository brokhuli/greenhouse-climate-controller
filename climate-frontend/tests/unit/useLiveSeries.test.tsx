import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { StreamContext, type StreamContextValue } from "../../src/app/stream-context";
import { liveSeriesKey, useLiveSeries } from "../../src/hooks/useLiveSeries";
import type { TelemetryFrame } from "../../src/api/schemas";

const frame = (greenhouseId: string, value: number): TelemetryFrame => ({
  schema_version: 1,
  greenhouse_id: greenhouseId,
  zone_id: null,
  ts: new Date(value * 1000).toISOString(),
  type: "telemetry",
  readings: [{ metric: "temperature", value, unit: "°C" }],
});

function makeStream() {
  const handlers = new Set<(frame: TelemetryFrame) => void>();
  const value: StreamContextValue = {
    connectionState: "open",
    subscribeTelemetry: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const emit = (telemetry: TelemetryFrame) => handlers.forEach((handler) => handler(telemetry));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StreamContext.Provider value={value}>{children}</StreamContext.Provider>
  );
  return { emit, wrapper };
}

/** Let the hook's coalesced (requestAnimationFrame) flush commit within `act`. */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("useLiveSeries", () => {
  it("accumulates this greenhouse's readings per metric and ignores others", async () => {
    const { emit, wrapper } = makeStream();
    const { result } = renderHook(() => useLiveSeries("gh-a"), { wrapper });

    await act(async () => {
      emit(frame("gh-a", 21));
      emit(frame("gh-a", 22));
      emit(frame("gh-b", 99)); // different greenhouse — ignored
      await nextFrame();
    });

    expect(result.current.get(liveSeriesKey("temperature"))?.map((r) => r.value)).toEqual([21, 22]);
  });

  it("caps each buffer at the capacity (ring buffer)", async () => {
    const { emit, wrapper } = makeStream();
    const { result } = renderHook(() => useLiveSeries("gh-a", 3), { wrapper });

    await act(async () => {
      for (let value = 1; value <= 5; value += 1) emit(frame("gh-a", value));
      await nextFrame();
    });

    expect(result.current.get(liveSeriesKey("temperature"))?.map((r) => r.value)).toEqual([
      3, 4, 5,
    ]);
  });
});
