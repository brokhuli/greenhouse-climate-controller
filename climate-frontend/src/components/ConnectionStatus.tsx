import { Radio, RefreshCw, Wifi, WifiOff } from "lucide-react";
import type { ConnectionState } from "./connection";

/**
 * Live indicator of the WebSocket health — the single most important trust signal on a real-time
 * dashboard (components spec §1). Never color-only: each state pairs an icon and a text label
 * (constraints §a11y). `TopBar` feeds it the live `StreamClient` state via `connectionStateFromWs`.
 */

const STATE_META: Record<ConnectionState, { label: string; color: string; Icon: typeof Wifi }> = {
  live: { label: "Live", color: "var(--color-status-online)", Icon: Wifi },
  reconnecting: { label: "Reconnecting", color: "var(--color-status-degraded)", Icon: RefreshCw },
  polling: { label: "Polling", color: "var(--color-warning)", Icon: Radio },
  offline: { label: "Offline", color: "var(--color-status-offline)", Icon: WifiOff },
};

export function ConnectionStatus({ state }: { state: ConnectionState }) {
  const { label, color, Icon } = STATE_META[state];
  return (
    <span
      role="status"
      aria-live="polite"
      className="text-fg-default inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm"
      style={{ backgroundColor: "var(--color-surface-raised)" }}
    >
      <Icon size={14} aria-hidden style={{ color }} />
      <span>{label}</span>
    </span>
  );
}
