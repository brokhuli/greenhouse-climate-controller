import { createContext, useContext } from "react";
import type { FrameType, TelemetryFrame } from "../api/schemas";
import type { WsConnectionState } from "../api/ws";

/**
 * Running tally of known-type frames the stream dropped for schema mismatch — wire drift between the
 * platform and this client's Zod schemas. A non-zero `count` means telemetry-driven surfaces (charts,
 * stat cards) may be silently stale, so the TopBar surfaces it and a mysterious freeze becomes a
 * named signal. The contract-parity tests are the build-time guard; this is the runtime one.
 */
export type SchemaDrift = {
  count: number;
  lastType: FrameType | null;
  lastIssue: string | null;
};

/**
 * The live-stream context: the single `StreamClient`'s connection state (drives `ConnectionStatus`),
 * a telemetry-frame subscription used by `useLiveSeries`, and the schema-drift tally. Split from the
 * provider component so the Fast-Refresh boundary stays clean (mirrors the theme/toast context split).
 */
export type StreamContextValue = {
  connectionState: WsConnectionState;
  /** Subscribe to every telemetry frame; returns an unsubscribe. */
  subscribeTelemetry: (handler: (frame: TelemetryFrame) => void) => () => void;
  /** How many known-type frames have been dropped for schema mismatch this session. */
  schemaDrift: SchemaDrift;
};

export const StreamContext = createContext<StreamContextValue | null>(null);

export function useStream(): StreamContextValue {
  const context = useContext(StreamContext);
  if (!context) throw new Error("useStream must be used within a StreamProvider");
  return context;
}
