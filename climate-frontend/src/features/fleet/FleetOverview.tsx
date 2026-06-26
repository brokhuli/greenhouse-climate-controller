import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useFleet } from "../../api/queries/greenhouses";
import { useFleetSparklines } from "../../api/queries/fleet";
import { usePersistentRange } from "../../hooks/usePersistentRange";
import { statusRollup } from "../../lib/derivations";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorState } from "../../components/ui/ErrorState";
import { Skeleton } from "../../components/ui/Skeleton";
import { rangeMs } from "../greenhouse/range";
import { RangePicker } from "../greenhouse/RangePicker";
import { historyFor, indexFleetHistory } from "./fleetHistory";
import { FleetSummaryBar } from "./FleetSummaryBar";
import { FleetTimeScaleControl } from "./FleetTimeScaleControl";
import { GreenhouseCard } from "./GreenhouseCard";
import { RegisterGreenhouseDialog } from "./RegisterGreenhouseDialog";

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

/**
 * The landing view (components §2): a site rollup + a grid of greenhouse cards, patched live by
 * status/drift frames. A Register CTA opens the dialog; when any greenhouse is simulated, a
 * fleet-wide speed control appears in the toolbar.
 */
export default function FleetOverview() {
  const fleet = useFleet();
  const [registerOpen, setRegisterOpen] = useState(false);

  // The card window is a deep-linkable ?window= choice (default 1h), independent of the detail view's
  // ?range=. Both pickers share the same option set (range.ts). The last pick persists across
  // remounts via localStorage, so navigating away and back keeps the chosen window.
  const [windowKey, setWindow] = usePersistentRange("window", "fleet:window");

  // One batched history fetch seeds every card's chart with the selected window (refreshed on an
  // interval inside the hook); the live WebSocket tail keeps the leading edge current between refreshes.
  const sparklines = useFleetSparklines(windowKey);
  const history = useMemo(() => indexFleetHistory(sparklines.data), [sparklines.data]);
  const windowMs = rangeMs(windowKey);

  const summaries = fleet.data ?? [];
  const anySim = summaries.some((summary) => summary.timeScale != null);
  const distinctScales = new Set(
    summaries.map((summary) => summary.timeScale).filter((scale): scale is number => scale != null),
  );
  const commonScale = distinctScales.size === 1 ? [...distinctScales][0] : null;

  return (
    <div className="flex flex-col" style={{ gap: "var(--layout-section-gap)" }}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-fg-default text-lg font-semibold">Fleet overview</h2>
        <div className="flex flex-wrap items-center gap-3">
          {anySim ? (
            <>
              <span className="text-fg-muted text-sm">Speed</span>
              <FleetTimeScaleControl currentScale={commonScale} />
            </>
          ) : null}
          {summaries.length > 0 ? (
            <>
              <span className="text-fg-muted text-sm">Timescale</span>
              <RangePicker value={windowKey} onChange={setWindow} />
            </>
          ) : null}
          <Button variant="primary" onClick={() => setRegisterOpen(true)}>
            <Plus size={16} aria-hidden />
            Register
          </Button>
        </div>
      </div>

      {fleet.isLoading ? (
        <div className={GRID}>
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} height={288} />
          ))}
        </div>
      ) : fleet.isError ? (
        <ErrorState
          title="Couldn't load the fleet"
          message={fleet.error?.message}
          onRetry={() => void fleet.refetch()}
        />
      ) : summaries.length === 0 ? (
        <EmptyState
          title="No greenhouses registered"
          message="Register a greenhouse to begin monitoring the fleet."
          action={
            <Button variant="primary" onClick={() => setRegisterOpen(true)}>
              Register greenhouse
            </Button>
          }
        />
      ) : (
        <>
          <FleetSummaryBar rollup={statusRollup(summaries)} />
          <div className={GRID}>
            {summaries.map((summary) => (
              <GreenhouseCard
                key={summary.id}
                summary={summary}
                history={historyFor(history, summary.id)}
                windowMs={windowMs}
              />
            ))}
          </div>
        </>
      )}

      <RegisterGreenhouseDialog open={registerOpen} onClose={() => setRegisterOpen(false)} />
    </div>
  );
}
