import { AlertTriangle } from "lucide-react";
import type { SchemaDrift } from "../app/stream-context";

/**
 * Warns that the live stream is dropping frames whose shape this build's Zod schemas no longer
 * accept — wire drift between the platform and this client. Renders nothing until at least one frame
 * is rejected; when it appears, the "charts and stat cards froze but actuators are fine" symptom has
 * a name and a cause instead of being an invisible silent drop. Icon + text (never color-only),
 * mirroring `ConnectionStatus` (constraints §a11y); the offending validation issue rides the tooltip.
 */
export function SchemaDriftBadge({ drift }: { drift: SchemaDrift }) {
  if (drift.count === 0) return null;
  const scope = drift.lastType ? ` (${drift.lastType})` : "";
  return (
    <span
      role="status"
      aria-live="polite"
      title={drift.lastIssue ?? undefined}
      className="text-fg-default inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm"
      style={{ backgroundColor: "var(--color-surface-raised)" }}
    >
      <AlertTriangle size={14} aria-hidden style={{ color: "var(--color-warning)" }} />
      <span>Telemetry schema mismatch{scope}</span>
    </span>
  );
}
