import type { WsConnectionState } from "../api/ws";

/** The operator-facing connection indicator states (components §1). */
export type ConnectionState = "live" | "reconnecting" | "polling" | "offline";

/** Map the `StreamClient` connection state onto the operator-facing indicator state. */
export function connectionStateFromWs(ws: WsConnectionState): ConnectionState {
  switch (ws) {
    case "open":
      return "live";
    case "connecting":
    case "reconnecting":
      return "reconnecting";
    case "closed":
      return "offline";
  }
}
