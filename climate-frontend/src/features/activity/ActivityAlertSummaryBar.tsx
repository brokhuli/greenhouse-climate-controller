import { BellRing, CircleCheck, TriangleAlert, Waves } from "lucide-react";
import { SummaryStat } from "../../components/ui/SummaryStat";
import type { ActiveAlertRollup } from "../../lib/derivations";

const GRID_STYLE = { gap: "var(--layout-card-gap)" };

/** At-a-glance current-alert triage, intentionally not a set of feed filter controls. */
export function ActivityAlertSummaryBar({ rollup }: { rollup: ActiveAlertRollup }) {
  return (
    <div
      className="grid grid-cols-2 lg:grid-cols-4"
      style={GRID_STYLE}
      aria-label="Active alert summary"
    >
      <SummaryStat
        label="Active Alarms"
        value={rollup.alarms}
        caption="Critical controller faults"
        Icon={BellRing}
        color="var(--color-fault)"
        dot={rollup.alarms > 0}
      />
      <SummaryStat
        label="Active Warnings"
        value={rollup.warnings}
        caption="Degraded but operating"
        Icon={TriangleAlert}
        color="var(--color-warning)"
        dot={rollup.warnings > 0}
      />
      <SummaryStat
        label="Affected Greenhouses"
        value={rollup.affected}
        caption="With matching active alerts"
        Icon={Waves}
        color="var(--color-status-degraded)"
        dot={rollup.affected > 0}
      />
      <SummaryStat
        label="Clear Greenhouses"
        value={rollup.clear}
        caption="No matching active alerts"
        Icon={CircleCheck}
        color="var(--color-status-online)"
      />
    </div>
  );
}
