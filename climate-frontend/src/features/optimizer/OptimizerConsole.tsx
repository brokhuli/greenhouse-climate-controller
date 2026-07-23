import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Lock } from "lucide-react";
import type { Escalation, OptimizerOutcomeStatus } from "../../api/schemas";
import { useFleet } from "../../api/queries/greenhouses";
import {
  useOptimizerEnabled,
  useOptimizerEscalations,
  useOptimizerFleet,
  useOptimizerModel,
  useOptimizerStatus,
  useSetOptimizerEnabled,
  useSetOptimizerModel,
} from "../../api/queries/optimizer";
import { useRole } from "../../hooks/useRole";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorState } from "../../components/ui/ErrorState";
import { PanelHeader } from "../../components/ui/PanelHeader";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/toast-context";
import { OptimizerHealthBadge } from "./badges";
import { ModelSelector, OptimizerEnableToggle, OptimizerRollupBar } from "./controls";
import { compareFleetTriage } from "./derivations";
import { optimizerActionError } from "./errors";
import { FleetOptimizerRow } from "./FleetOptimizerRow";

const SECTION_STYLE = { gap: "var(--layout-section-gap)" };

const STATUS_FILTERS: { value: OptimizerOutcomeStatus | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "applied", label: "Applied" },
  { value: "escalated", label: "Escalated" },
  { value: "extended", label: "Extended" },
];

const isOutcomeStatus = (value: string | null): value is OptimizerOutcomeStatus =>
  value === "applied" || value === "escalated" || value === "extended";

/**
 * The `/optimizer` view (frontend components §OptimizerConsole): the service-health header, the site
 * rollup, and the whole-fleet optimizer table with the escalation worklist. The per-greenhouse plan
 * detail (diff / confidence / backend) is not here — it is the `OptimizerPlanPanel` on the greenhouse
 * detail view (hybrid split). All reads are polled; every action is operator-gated.
 */
export default function OptimizerConsole() {
  const status = useOptimizerStatus();
  const fleetOpt = useOptimizerFleet();
  const escalations = useOptimizerEscalations();
  const model = useOptimizerModel();
  const enabled = useOptimizerEnabled();
  const fleet = useFleet();
  const { isOperator } = useRole();
  const toast = useToast();
  const setEnabled = useSetOptimizerEnabled();
  const setModel = useSetOptimizerModel();

  const [searchParams, setSearchParams] = useSearchParams();
  const statusParam = searchParams.get("status");
  const statusFilter = isOutcomeStatus(statusParam) ? statusParam : "";
  const ghParam = searchParams.get("greenhouse_id");

  const setStatusFilter = (value: OptimizerOutcomeStatus | "") => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("status", value);
    else next.delete("status");
    setSearchParams(next);
  };

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of fleet.data ?? []) map.set(g.id, g.displayName);
    return map;
  }, [fleet.data]);

  // One open escalation per greenhouse (the standing entry after dedup) — the row's Resolve target.
  const escalationByGreenhouse = useMemo(() => {
    const map = new Map<string, Escalation>();
    for (const esc of escalations.data ?? []) {
      if (!map.has(esc.greenhouseId)) map.set(esc.greenhouseId, esc);
    }
    return map;
  }, [escalations.data]);

  const serviceEnabled = enabled.data?.enabled ?? status.data?.enabled ?? true;

  const rows = useMemo(() => {
    const all = fleetOpt.data?.greenhouses ?? [];
    const filtered = all.filter(
      (g) =>
        (statusFilter === "" || g.status === statusFilter) &&
        (!ghParam || g.greenhouseId === ghParam),
    );
    // The escalation worklist sorts persistent-before-transient, oldest first; otherwise a stable
    // greenhouse-id order so the table doesn't reshuffle between polls.
    return statusFilter === "escalated"
      ? [...filtered].sort(compareFleetTriage)
      : [...filtered].sort((a, b) => a.greenhouseId.localeCompare(b.greenhouseId));
  }, [fleetOpt.data, statusFilter, ghParam]);

  const toggleService = (next: boolean) =>
    setEnabled.mutate(
      { enabled: next },
      {
        onSuccess: () =>
          toast.push({
            variant: "success",
            title: next ? "Optimizer resumed" : "Optimizer paused",
            message: next
              ? "Planning resumed fleet-wide"
              : "Read-only — planning stopped fleet-wide",
          }),
        onError: (error) =>
          toast.push({
            variant: "warning",
            title: "Couldn't update the optimizer",
            message: optimizerActionError(error, "Update failed"),
          }),
      },
    );

  const selectModel = (next: string) =>
    setModel.mutate(
      { model: next },
      {
        onSuccess: () =>
          toast.push({
            variant: "success",
            title: "Model updated",
            message: `${next} — takes effect next cycle`,
          }),
        onError: (error) =>
          toast.push({
            variant: "warning",
            title: "Couldn't switch model",
            message: optimizerActionError(error, "Model switch failed"),
          }),
      },
    );

  const nowMs = Date.now();
  const total = fleetOpt.data?.greenhouses.length ?? 0;

  return (
    <div className="flex flex-col" style={SECTION_STYLE}>
      {/* Toolbar: global pause/resume + model selection. */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {model.data ? (
          <ModelSelector
            model={model.data}
            onSelect={selectModel}
            pending={setModel.isPending}
            disabled={!isOperator}
            disabledReason="Operator role required"
          />
        ) : null}
        {enabled.data || status.data ? (
          <OptimizerEnableToggle
            enabled={serviceEnabled}
            scope="global"
            onChange={toggleService}
            pending={setEnabled.isPending}
            disabled={!isOperator}
            disabledReason="Operator role required"
          />
        ) : null}
      </div>

      {!serviceEnabled ? (
        <div
          role="status"
          className="text-fg-default flex items-center gap-2 rounded-md px-3 py-2 text-sm"
          style={{
            backgroundColor: "var(--color-surface-raised)",
            borderLeft: "3px solid var(--color-status-offline)",
          }}
        >
          <Lock size={16} aria-hidden style={{ color: "var(--color-status-offline)" }} />
          <span>
            Optimizer is paused (read-only) — planning is stopped fleet-wide. Resume to continue.
          </span>
        </div>
      ) : null}

      {/* Service-health header + site rollup. */}
      <div className="flex flex-col" style={{ gap: "var(--layout-card-gap)" }}>
        <Card>
          <PanelHeader title="Service health" sectionLabel titleSize="large" />
          {status.isLoading ? (
            <Skeleton height={64} />
          ) : status.data ? (
            <OptimizerHealthBadge status={status.data} now={new Date(nowMs)} />
          ) : (
            <p className="text-fg-subtle text-sm">Service status unavailable.</p>
          )}
        </Card>
        {fleetOpt.data ? <OptimizerRollupBar rollup={fleetOpt.data.rollup} /> : null}
      </div>

      {/* Status filter — escalated yields the worklist. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-fg-muted text-sm">Filter</span>
        {STATUS_FILTERS.map((option) => (
          <Button
            key={option.value || "all"}
            variant={statusFilter === option.value ? "primary" : "secondary"}
            onClick={() => setStatusFilter(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      {/* Table / states. */}
      {fleetOpt.isLoading ? (
        <Skeleton height={240} />
      ) : fleetOpt.isError ? (
        <ErrorState
          title="Optimizer fleet data unavailable"
          message="The optimizer may be unreachable. The service-health badge above reflects its status."
          onRetry={() => void fleetOpt.refetch()}
        />
      ) : total === 0 ? (
        <EmptyState
          title="No greenhouses registered"
          message="Register a greenhouse to begin optimizer planning."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title={
            statusFilter === "escalated"
              ? "No open escalations"
              : "No greenhouses match this filter"
          }
          message={
            statusFilter === "escalated"
              ? "All cycles applied or extended."
              : "Clear the filter to see the whole fleet."
          }
        />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-fg-subtle text-left">
                  <th className="section-label py-1 font-normal">Greenhouse</th>
                  <th className="section-label py-1 font-normal">Status</th>
                  <th className="section-label py-1 font-normal">Last cycle</th>
                  <th className="section-label py-1 text-right font-normal">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => (
                  <FleetOptimizerRow
                    key={entry.greenhouseId}
                    entry={entry}
                    displayName={nameById.get(entry.greenhouseId) ?? entry.greenhouseId}
                    serviceEnabled={serviceEnabled}
                    escalation={escalationByGreenhouse.get(entry.greenhouseId)}
                    nowMs={nowMs}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
