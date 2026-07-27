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
import { StreamContext, type SchemaDrift, type StreamContextValue } from "./stream-context";

const NO_DRIFT: SchemaDrift = { count: 0, lastType: null, lastIssue: null };

/**
 * Mounts exactly one `StreamClient` for the app, patches the Query cache from every status/drift/
 * event frame (architecture §4), fans telemetry out to `useLiveSeries` subscribers, raises a toast
 * on critical events, exposes the connection state for `ConnectionStatus`, and tallies any known-type
 * frame the schema rejects (wire drift) so the TopBar can flag that live surfaces may be stale.
 */
export function StreamProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [connectionState, setConnectionState] = useState<WsConnectionState>("closed");
  const [schemaDrift, setSchemaDrift] = useState<SchemaDrift>(NO_DRIFT);

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
        // A known-type frame the platform sent but our schema rejects: the wire has drifted. Tally it
        // so the TopBar can flag that live surfaces may be stale (setSchemaDrift is stable, so the
        // once-created handler can call it directly without a ref).
        onFrameRejected: (type, error) =>
          setSchemaDrift((prev) => ({
            count: prev.count + 1,
            lastType: type,
            lastIssue: error.issues[0]?.message ?? "schema mismatch",
          })),
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
    () => ({ connectionState, subscribeTelemetry, schemaDrift }),
    [connectionState, subscribeTelemetry, schemaDrift],
  );

  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>;
}
