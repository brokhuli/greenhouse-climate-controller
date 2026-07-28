import { ArrowDown, ArrowUp, Minus, TriangleAlert } from "lucide-react";
import type { SetpointDiff } from "../../api/schemas";
import { setpointDiffRows, type SetpointDiffRow } from "./derivations";

/** At most two decimals, trailing zeros stripped (900 → "900", 22.5 → "22.5", 1.05 → "1.05"). */
const fmt = (n: number): string => String(Math.round(n * 100) / 100);

const DIRECTION: Record<SetpointDiffRow["direction"], { Icon: typeof ArrowUp; label: string }> = {
  up: { Icon: ArrowUp, label: "increase" },
  down: { Icon: ArrowDown, label: "decrease" },
  same: { Icon: Minus, label: "no change" },
};

/**
 * The proposed-vs-current setpoint diff, one row per changed scalar climate target. Unchanged fields
 * are collapsed; a value at or near its crop-safe bound is flagged. Presentational — the feature
 * supplies the Go-API-composed `SetpointDiff` (proposed patch + current bundle + crop-safe bounds).
 */
export function SetpointDiffTable({ diff }: { diff: SetpointDiff }) {
  const rows = setpointDiffRows(diff);
  if (rows.length === 0) {
    return <p className="text-fg-subtle text-sm">No setpoint changes proposed.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-fg-subtle text-left">
          <th className="section-label py-1 font-normal">Setpoint</th>
          <th className="section-label py-1 text-right font-normal">Current</th>
          <th className="section-label py-1 text-right font-normal">Proposed</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const { Icon, label } = DIRECTION[row.direction];
          return (
            <tr key={row.field} className="border-divider border-t">
              <td className="text-fg-default py-1.5">
                <span className="inline-flex items-center gap-1.5">
                  {row.label}
                  {row.nearBound ? (
                    <TriangleAlert
                      size={13}
                      aria-label="near crop-safe bound"
                      style={{ color: "var(--color-status-degraded)" }}
                    />
                  ) : null}
                </span>
              </td>
              <td className="text-fg-muted py-1.5 text-right tabular-nums">
                {fmt(row.current)}
                <span className="text-fg-subtle"> {row.unit}</span>
              </td>
              <td className="text-fg-default py-1.5 text-right tabular-nums">
                <span className="inline-flex items-center justify-end gap-1">
                  <Icon
                    size={13}
                    aria-label={label}
                    style={{
                      color:
                        row.direction === "up"
                          ? "var(--color-status-online)"
                          : row.direction === "down"
                            ? "var(--color-info)"
                            : "var(--color-fg-subtle)",
                    }}
                  />
                  {fmt(row.proposed)}
                  <span className="text-fg-subtle"> {row.unit}</span>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
