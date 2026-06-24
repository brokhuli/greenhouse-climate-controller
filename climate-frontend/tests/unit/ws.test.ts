import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StreamClient,
  type StreamClientOptions,
  type WebSocketLike,
  type WsConnectionState,
} from "../../src/api/ws";
import { wsFixture } from "../fixtures";

class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
}

const setup = (options: Partial<StreamClientOptions> = {}) => {
  const sockets: FakeSocket[] = [];
  const client = new StreamClient({
    baseDelayMs: 100,
    maxDelayMs: 1000,
    urlResolver: () => "ws://test/api/stream",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  return { client, sockets };
};

afterEach(() => vi.useRealTimers());

describe("StreamClient", () => {
  it("dispatches a valid telemetry frame", () => {
    const onTelemetry = vi.fn();
    const { client, sockets } = setup({ handlers: { onTelemetry } });
    client.connect();
    sockets[0].onopen?.({});
    sockets[0].onmessage?.({ data: JSON.stringify(wsFixture("telemetry.json")) });
    expect(onTelemetry).toHaveBeenCalledOnce();
    client.close();
  });

  it("routes an unknown frame type to onUnknown, not a handler", () => {
    const onUnknown = vi.fn();
    const onTelemetry = vi.fn();
    const { client, sockets } = setup({ handlers: { onUnknown, onTelemetry } });
    client.connect();
    sockets[0].onmessage?.({
      data: JSON.stringify({
        schema_version: 1,
        greenhouse_id: "gh-a",
        zone_id: null,
        ts: "2026-06-17T00:00:00.000Z",
        type: "mystery",
      }),
    });
    expect(onUnknown).toHaveBeenCalledOnce();
    expect(onTelemetry).not.toHaveBeenCalled();
    client.close();
  });

  it("drops an invalid known frame (bad unit) without dispatching", () => {
    const onTelemetry = vi.fn();
    const { client, sockets } = setup({ handlers: { onTelemetry } });
    client.connect();
    sockets[0].onmessage?.({ data: JSON.stringify(wsFixture("telemetry.bad-unit.json")) });
    expect(onTelemetry).not.toHaveBeenCalled();
    client.close();
  });

  it("ignores non-JSON payloads without throwing", () => {
    const onUnknown = vi.fn();
    const { client, sockets } = setup({ handlers: { onUnknown } });
    client.connect();
    expect(() => sockets[0].onmessage?.({ data: "not json" })).not.toThrow();
    expect(onUnknown).not.toHaveBeenCalled();
    client.close();
  });

  it("reconnects with backoff after a drop", () => {
    vi.useFakeTimers();
    const states: WsConnectionState[] = [];
    const { client, sockets } = setup({ onStateChange: (s) => states.push(s) });
    client.connect();
    sockets[0].onopen?.({});
    sockets[0].onclose?.({});
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
    expect(states).toEqual(["connecting", "open", "reconnecting"]);
    client.close();
  });

  it("stops reconnecting once closed", () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    client.connect();
    sockets[0].onclose?.({});
    client.close();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(1);
  });
});
