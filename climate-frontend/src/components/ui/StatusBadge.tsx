import { TriangleAlert, Wifi, WifiOff } from "lucide-react";
import type { Connectivity } from "../../api/schemas";

/**
 * Connectivity/health pill: online / degraded / offline, plus an optional drift marker
 * (components §3). Always icon + label, never color-only (constraints §a11y). Offline is muted,
 * not alarming — an absence of data, not a fault.
 */
const META: Record<Connectivity, { label: string; color: string; Icon: typeof Wifi }> = {
  online: { label: "Online", color: "var(--color-status-online)", Icon: Wifi },
  degraded: { label: "Degraded", color: "var(--color-status-degraded)", Icon: TriangleAlert },
  offline: { label: "Offline", color: "var(--color-status-offline)", Icon: WifiOff },
};

export function StatusBadge({ status, drift = false }: { status: Connectivity; drift?: boolean }) {
  const { label, color, Icon } = META[status];
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="border-border bg-surface-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
        style={{ color }}
      >
        <Icon size={12} aria-hidden />
        {label}
      </span>
      {drift ? (
        <span
          className="border-border bg-surface-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
          style={{ color: "var(--color-status-drift)" }}
        >
          Drift
        </span>
      ) : null}
    </span>
  );
}
