import { Activity, Ban, CircleCheck, Target, TriangleAlert } from "lucide-react";
import type { StatusRollup } from "../../lib/derivations";
import { SummaryStat } from "../../components/ui/SummaryStat";

const GRID_STYLE = { gap: "var(--layout-card-gap)" };

/**
 * Site-level rollup bar (components §2): total greenhouses, healthy, attention needed, offline, and
 * drift. Fits five across on wide desktop before wrapping.
 */
export function FleetSummaryBar({ rollup }: { rollup: StatusRollup }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" style={GRID_STYLE}>
      <SummaryStat
        label="Total Greenhouses"
        value={rollup.total}
        caption="All sites"
        Icon={Activity}
        color="var(--chart-temperature)"
      />
      <SummaryStat
        label="Healthy"
        value={rollup.online}
        caption="Reporting normally"
        Icon={CircleCheck}
        color="var(--chart-temperature)"
      />
      <SummaryStat
        label="Attention Needed"
        value={rollup.degraded}
        caption="Degraded"
        dot
        Icon={TriangleAlert}
        color="var(--color-status-degraded)"
      />
      <SummaryStat
        label="Offline"
        value={rollup.offline}
        caption="No data"
        Icon={Ban}
        color="var(--color-status-offline)"
      />
      <SummaryStat
        label="Drift Detected"
        value={rollup.drift}
        caption="Setpoints mismatched"
        dot
        Icon={Target}
        color="var(--color-status-drift)"
      />
    </div>
  );
}
