import type { StatusRollup } from "../../lib/derivations";

/**
 * Site-level rollup cards (components §2): total greenhouses, online, degraded, offline, drift.
 * Large tabular numbers with short captions; fits five across on wide desktop before wrapping.
 */
function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="border-border bg-surface-1 rounded-lg border p-4">
      <p
        className="font-mono text-2xl font-semibold tabular-nums"
        style={color ? { color } : undefined}
      >
        {value}
      </p>
      <p className="section-label mt-1">{label}</p>
    </div>
  );
}

export function FleetSummaryBar({ rollup }: { rollup: StatusRollup }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      <Stat label="Greenhouses" value={rollup.total} />
      <Stat label="Online" value={rollup.online} color="var(--color-status-online)" />
      <Stat label="Degraded" value={rollup.degraded} color="var(--color-status-degraded)" />
      <Stat label="Offline" value={rollup.offline} color="var(--color-status-offline)" />
      <Stat label="Drift" value={rollup.drift} color="var(--color-status-drift)" />
    </div>
  );
}
