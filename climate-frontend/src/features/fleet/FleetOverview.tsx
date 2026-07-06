import { useMemo, useState } from "react";
import { Plus, TriangleAlert } from "lucide-react";
import { useFleet } from "../../api/queries/greenhouses";
import { fleetStaleNotice, isStreamDegraded, useFleetSparklines } from "../../api/queries/fleet";
import { useStream } from "../../app/stream-context";
import { usePersistentRange } from "../../hooks/usePersistentRange";
import { useRole } from "../../hooks/useRole";
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

const GRID = "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";
const GRID_STYLE = { gap: "var(--layout-card-gap)" };
const TOOLBAR_STYLE = { gap: "var(--layout-toolbar-gap)" };

/**
 * The landing view (components §2): a site rollup + a grid of greenhouse cards, patched live by
 * status/drift frames. A Register CTA opens the dialog; when any greenhouse is simulated, a
 * fleet-wide speed control appears in the toolbar.
 */
export default function FleetOverview() {
  const fleet = useFleet();
  const { isOperator } = useRole();
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

  // The charts refresh slower (and rely on stale cache) when the live stream is degraded or a poll
  // fails, so tell the operator rather than let frozen charts read as live.
  const { connectionState } = useStream();
  const staleNotice = fleetStaleNotice(isStreamDegraded(connectionState), sparklines.isError);

  const summaries = fleet.data ?? [];
  const anySim = summaries.some((summary) => summary.timeScale != null);
  const distinctScales = new Set(
    summaries.map((summary) => summary.timeScale).filter((scale): scale is number => scale != null),
  );
  const commonScale = distinctScales.size === 1 ? [...distinctScales][0] : null;

  return (
    <div className="flex flex-col" style={{ gap: "var(--layout-section-gap)" }}>
      <div className="flex items-center justify-end gap-3">
        <div className="flex flex-wrap items-center" style={TOOLBAR_STYLE}>
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
          <Button
            variant="primary"
            onClick={() => setRegisterOpen(true)}
            disabled={!isOperator}
            title={isOperator ? undefined : "Operator role required"}
          >
            <Plus size={16} aria-hidden />
            Register
          </Button>
        </div>
      </div>

      {fleet.isLoading ? (
        <div className={GRID} style={GRID_STYLE}>
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
            <Button
              variant="primary"
              onClick={() => setRegisterOpen(true)}
              disabled={!isOperator}
              title={isOperator ? undefined : "Operator role required"}
            >
              Register greenhouse
            </Button>
          }
        />
      ) : (
        <>
          {staleNotice ? (
            <div
              role="status"
              aria-live="polite"
              className="text-fg-default flex items-center gap-2 rounded-md px-3 py-2 text-sm"
              style={{
                backgroundColor: "var(--color-surface-raised)",
                borderLeft: "3px solid var(--color-status-degraded)",
              }}
            >
              <TriangleAlert
                size={16}
                aria-hidden
                style={{ color: "var(--color-status-degraded)" }}
              />
              <span>{staleNotice}</span>
            </div>
          ) : null}
          <FleetSummaryBar rollup={statusRollup(summaries)} />
          <div className={GRID} style={GRID_STYLE}>
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
