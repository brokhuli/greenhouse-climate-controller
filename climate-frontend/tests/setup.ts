import "@testing-library/jest-dom/vitest";

/**
 * jsdom lacks `WebSocket` and `ResizeObserver`, which the live stream (`StreamProvider`) and the
 * uPlot chart wrapper touch on mount. Stub them so components mount in tests; the socket stub never
 * opens (no frames), which is the inert default the unit tests want.
 */
class MockWebSocket {
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(public url: string) {}
  close(): void {}
  send(): void {}
}

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("WebSocket" in globalThis)) {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
}

// uPlot tracks devicePixelRatio via matchMedia at module init; jsdom doesn't implement it.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
