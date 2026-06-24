import { createContext, useContext } from "react";
import type { TelemetryFrame } from "../api/schemas";
import type { WsConnectionState } from "../api/ws";

/**
 * The live-stream context: the single `StreamClient`'s connection state (drives `ConnectionStatus`)
 * and a telemetry-frame subscription used by `useLiveSeries`. Split from the provider component so
 * the Fast-Refresh boundary stays clean (mirrors the theme/toast context split).
 */
export type StreamContextValue = {
  connectionState: WsConnectionState;
  /** Subscribe to every telemetry frame; returns an unsubscribe. */
  subscribeTelemetry: (handler: (frame: TelemetryFrame) => void) => () => void;
};

export const StreamContext = createContext<StreamContextValue | null>(null);

export function useStream(): StreamContextValue {
  const context = useContext(StreamContext);
  if (!context) throw new Error("useStream must be used within a StreamProvider");
  return context;
}
