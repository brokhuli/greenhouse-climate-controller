import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TelemetryFrame } from "../api/schemas";
import { createStreamClient, type WsConnectionState } from "../api/ws";
import { useToast } from "../components/ui/toast-context";
import {
  applyDriftFrame,
  applyEventFrame,
  applyStatusFrame,
  applyTelemetryFrame,
  eventFrameToEntry,
} from "../lib/livePatch";
import { StreamContext, type StreamContextValue } from "./stream-context";

/**
 * Mounts exactly one `StreamClient` for the app, patches the Query cache from every status/drift/
 * event frame (architecture §4), fans telemetry out to `useLiveSeries` subscribers, raises a toast
 * on critical events, and exposes the connection state for `ConnectionStatus`.
 */
export function StreamProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [connectionState, setConnectionState] = useState<WsConnectionState>("closed");

  const subscribers = useRef(new Set<(frame: TelemetryFrame) => void>());

  // The StreamClient is created once; refs let its handlers reach the current cache/toast handles.
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    const client = createStreamClient({
      onStateChange: setConnectionState,
      handlers: {
        onTelemetry: (frame) => {
          applyTelemetryFrame(queryClientRef.current, frame);
          for (const handler of subscribers.current) handler(frame);
        },
        onStatus: (frame) => applyStatusFrame(queryClientRef.current, frame),
        onDrift: (frame) => applyDriftFrame(queryClientRef.current, frame),
        onEvent: (frame) => {
          applyEventFrame(queryClientRef.current, frame);
          if (frame.severity === "critical") {
            toastRef.current.push({
              variant: "critical",
              title: `${frame.kind === "interlock" ? "Interlock" : "Fault"} · ${frame.greenhouse_id}`,
              message: eventFrameToEntry(frame).message,
            });
          }
        },
      },
    });
    client.connect();
    return () => client.close();
  }, []);

  const subscribeTelemetry = useCallback((handler: (frame: TelemetryFrame) => void) => {
    subscribers.current.add(handler);
    return () => {
      subscribers.current.delete(handler);
    };
  }, []);

  const value = useMemo<StreamContextValue>(
    () => ({ connectionState, subscribeTelemetry }),
    [connectionState, subscribeTelemetry],
  );

  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>;
}
