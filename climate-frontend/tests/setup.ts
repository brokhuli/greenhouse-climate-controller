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

// jsdom has no 2D canvas: `getContext("2d")` logs "Not implemented" and returns null, so uPlot
// constructs with a null context and then crashes asynchronously on the first draw (clearRect on
// null). Stub a no-op context so chart-bearing components (the fleet card sparklines) mount and
// render without a real canvas; the tests assert the surrounding DOM, not pixels.
if (typeof HTMLCanvasElement !== "undefined") {
  const noop = (): void => {};
  const gradient = { addColorStop: noop };
  const makeContext = (canvas: HTMLCanvasElement) =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "canvas") return canvas;
          if (prop === "measureText") return () => ({ width: 0 });
          if (prop === "createLinearGradient" || prop === "createRadialGradient")
            return () => gradient;
          return noop;
        },
        set: () => true,
      },
    );
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return makeContext(this);
  } as unknown as HTMLCanvasElement["getContext"];
}

// uPlot builds its line/fill geometry with Path2D, which jsdom doesn't define. A no-op stub is
// enough — nothing in tests reads the geometry back.
if (!("Path2D" in globalThis)) {
  class MockPath2D {
    addPath(): void {}
    moveTo(): void {}
    lineTo(): void {}
    rect(): void {}
    arc(): void {}
    closePath(): void {}
    bezierCurveTo(): void {}
    quadraticCurveTo(): void {}
  }
  (globalThis as unknown as { Path2D: unknown }).Path2D = MockPath2D;
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
