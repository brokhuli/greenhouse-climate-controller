import {
  driftFrame,
  eventFrame,
  statusFrame,
  telemetryFrame,
  type DriftFrame,
  type EventFrame,
  type StatusFrame,
  type TelemetryFrame,
} from "./schemas";
import { getAccessToken } from "./authToken";

/**
 * The single live-push channel: a thin wrapper over the browser `WebSocket` to the platform's
 * `/api/stream` fan-out. It connects, Zod-parses each frame, dispatches it to the registered
 * handler, reconnects with exponential backoff, and reports its connection state (which drives
 * `ConnectionStatus`). Per the contract, an envelope-valid frame whose `type` is unknown — or a
 * known frame that fails validation — is ignored rather than crashing the app (degrade, not blank).
 *
 * No dependency (socket.io etc.): the Go API speaks plain WebSockets and the message taxonomy is
 * small (frontend tech-stack §"Native WebSocket client").
 */

export type WsConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export type FrameHandlers = {
  onTelemetry?: (frame: TelemetryFrame) => void;
  onStatus?: (frame: StatusFrame) => void;
  onDrift?: (frame: DriftFrame) => void;
  onEvent?: (frame: EventFrame) => void;
  /** Called for envelope-valid-but-unknown frame types (forward compatibility). */
  onUnknown?: (raw: unknown) => void;
};

/** Minimal surface of the browser `WebSocket` this client uses (so it can be faked in tests). */
export interface WebSocketLike {
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type StreamClientOptions = {
  handlers?: FrameHandlers;
  onStateChange?: (state: WsConnectionState) => void;
  /** First reconnect delay; doubles each attempt up to `maxDelayMs`. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Overridable for tests. Default opens a real `WebSocket` at `/api/stream`. */
  socketFactory?: (url: string) => WebSocketLike;
  /** Overridable for tests. Default derives `ws(s)://host/api/stream`. */
  urlResolver?: () => string;
};

const defaultStreamUrl = (): string => {
  const base = import.meta.env.VITE_API_BASE;
  const streamUrl = base
    ? `${base.replace(/^http/, "ws")}/api/stream`
    : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/stream`;
  // A browser cannot set an Authorization header on the WS handshake, so the token (when present)
  // rides as a query param the API validates before upgrading. Resolved per (re)connect, so a
  // renewed token is picked up automatically.
  const token = getAccessToken();
  return token ? `${streamUrl}?access_token=${encodeURIComponent(token)}` : streamUrl;
};

const defaultSocketFactory = (url: string): WebSocketLike =>
  // The browser WebSocket satisfies the subset we use; the event-handler variance differs.
  new WebSocket(url) as unknown as WebSocketLike;

export class StreamClient {
  private readonly handlers: FrameHandlers;
  private readonly onStateChange?: (state: WsConnectionState) => void;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly socketFactory: (url: string) => WebSocketLike;
  private readonly urlResolver: () => string;

  private socket: WebSocketLike | null = null;
  private state: WsConnectionState = "closed";
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(options: StreamClientOptions = {}) {
    this.handlers = options.handlers ?? {};
    this.onStateChange = options.onStateChange;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 5000;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.urlResolver = options.urlResolver ?? defaultStreamUrl;
  }

  /** Open the socket (idempotent while connected). */
  connect(): void {
    this.stopped = false;
    if (this.socket) return;
    this.setState("connecting");
    this.open();
  }

  /** Close the socket and stop reconnecting. */
  close(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setState("closed");
  }

  getState(): WsConnectionState {
    return this.state;
  }

  private open(): void {
    const socket = this.socketFactory(this.urlResolver());
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      this.setState("open");
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onerror = () => {
      // A failed connection surfaces as a close; let onclose drive the reconnect.
    };
    socket.onclose = () => {
      this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.attempts);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private handleMessage(data: unknown): void {
    let raw: unknown;
    try {
      raw = typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      return; // non-JSON payloads are not part of the contract; ignore.
    }

    const type =
      typeof raw === "object" && raw !== null && "type" in raw
        ? (raw as { type: unknown }).type
        : undefined;

    switch (type) {
      case "telemetry": {
        const parsed = telemetryFrame.safeParse(raw);
        if (parsed.success) this.handlers.onTelemetry?.(parsed.data);
        return;
      }
      case "status": {
        const parsed = statusFrame.safeParse(raw);
        if (parsed.success) this.handlers.onStatus?.(parsed.data);
        return;
      }
      case "drift": {
        const parsed = driftFrame.safeParse(raw);
        if (parsed.success) this.handlers.onDrift?.(parsed.data);
        return;
      }
      case "event": {
        const parsed = eventFrame.safeParse(raw);
        if (parsed.success) this.handlers.onEvent?.(parsed.data);
        return;
      }
      default:
        this.handlers.onUnknown?.(raw);
    }
  }

  private setState(state: WsConnectionState): void {
    if (state === this.state) return;
    this.state = state;
    this.onStateChange?.(state);
  }
}

export const createStreamClient = (options?: StreamClientOptions): StreamClient =>
  new StreamClient(options);
