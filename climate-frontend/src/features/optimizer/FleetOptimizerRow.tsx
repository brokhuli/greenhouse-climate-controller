import { Link } from "react-router-dom";
import { ChevronRight, CloudOff } from "lucide-react";
import type { FleetOptimizerGreenhouse } from "../../api/schemas";
import {
  useSetGreenhouseOptimizerEnabled,
  useTriggerOptimizerCycle,
} from "../../api/queries/optimizer";
import { useRole } from "../../hooks/useRole";
import { Pill } from "../../components/ui/Pill";
import { useToast } from "../../components/ui/toast-context";
import { OptimizerStatusPill, ReasonCodeChip } from "./badges";
import { OptimizerEnableToggle, TriggerCycleAction } from "./controls";
import { formatDurationSecs, toOptimizerCardState } from "./derivations";
import { optimizerActionError } from "./errors";
import { pipelineStages } from "./pipeline";
import { PipelineTracker } from "./PipelineTracker";

/** Seconds between an event and `nowMs`, floored at 0. */
const ageSecs = (date: Date, nowMs: number): number =>
  Math.max(0, Math.round((nowMs - date.getTime()) / 1000));

/**
 * One greenhouse row in the fleet optimizer table. Owns the per-greenhouse operator mutations
 * (trigger, per-greenhouse pause/resume, resolve) so each row tracks its own pending state; reads
 * stay viewer-open. The plan detail (diff/confidence/backend) lives on the greenhouse detail view,
 * linked from here (hybrid split).
 */
const MUTED = "var(--color-status-offline)";

export function FleetOptimizerRow({
  entry,
  displayName,
  serviceEnabled,
  offline,
  nowMs,
}: {
  entry: FleetOptimizerGreenhouse;
  displayName: string;
  serviceEnabled: boolean;
  offline: boolean;
  nowMs: number;
}) {
  const { isOperator } = useRole();
  const toast = useToast();
  const trigger = useTriggerOptimizerCycle(entry.greenhouseId);
  const setEnabled = useSetGreenhouseOptimizerEnabled(entry.greenhouseId);

  const state = toOptimizerCardState(entry, serviceEnabled);
  const nonAppliedOutcome = entry.status === "held" || entry.status === "failed";
  const outcomeMessage = entry.message;
  const operatorReason = isOperator ? undefined : "Operator role required";
  // Global precedence: while the service is globally paused, per-greenhouse controls can't act.
  const globallyPaused = !serviceEnabled;
  const toggleReason = !isOperator
    ? operatorReason
    : globallyPaused
      ? "Service is globally paused"
      : undefined;

  const runCycle = () =>
    trigger.mutate(
      {},
      {
        onSuccess: () =>
          toast.push({
            variant: "success",
            title: "Cycle triggered",
            message: `${displayName} — planning now`,
          }),
        onError: (error) =>
          toast.push({
            variant: "warning",
            title: "Couldn't start cycle",
            message: optimizerActionError(error, "Trigger failed"),
          }),
      },
    );

  const toggle = (next: boolean) =>
    setEnabled.mutate(
      { enabled: next },
      {
        onSuccess: () =>
          toast.push({
            variant: "success",
            title: next ? "Greenhouse resumed" : "Greenhouse paused",
            message: displayName,
          }),
        onError: (error) =>
          toast.push({
            variant: "warning",
            title: "Couldn't update greenhouse",
            message: optimizerActionError(error, "Update failed"),
          }),
      },
    );

  // A greenhouse known but never cycled has no createdAt — its "last cycle" cell reads as a dash.
  const lastCycleLabel = entry.createdAt
    ? `${formatDurationSecs(ageSecs(entry.createdAt, nowMs))} ago`
    : "—";

  // The live pipeline tracker sits in a full-width sub-row beneath the summary, where the six stages
  // have horizontal room. Offline greenhouses are not planning, so they show no pipeline.
  const pipeline = pipelineStages(entry, state, outcomeMessage);
  const terminalNode = pipeline.find(
    (node) => node.state === "failed" || node.state === "held" || node.state === "unchanged",
  );
  const outcomeFeedback = outcomeMessage
    ? entry.status === "applied"
      ? `Publish applied: ${outcomeMessage}`
      : terminalNode
        ? `${terminalNode.label} ${terminalNode.state}: ${outcomeMessage}`
        : null
    : null;

  return (
    <>
      <tr className="border-divider border-t align-top">
        <td className="py-3 pr-3 whitespace-nowrap">
          <Link
            to={`/greenhouses/${entry.greenhouseId}`}
            className="text-fg-default hover:text-accent inline-flex items-center gap-1 font-medium"
          >
            {displayName}
            <ChevronRight size={14} className="text-fg-subtle" aria-hidden />
          </Link>
        </td>
        <td className="py-3 pr-3">
          {offline ? (
            <Pill color={MUTED} icon={<CloudOff size={12} aria-hidden />}>
              Offline — not planning
            </Pill>
          ) : (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <OptimizerStatusPill state={state} />
                {nonAppliedOutcome && entry.reasonCode ? (
                  <ReasonCodeChip code={entry.reasonCode} />
                ) : null}
              </div>
              {/* State the pipeline stage and outcome alongside the backend's actionable detail. */}
              {outcomeFeedback ? (
                <p
                  className="text-fg-subtle line-clamp-3 text-xs break-words"
                  title={outcomeFeedback}
                >
                  {outcomeFeedback}
                </p>
              ) : null}
            </div>
          )}
        </td>
        <td className="text-fg-muted py-3 pr-3 text-xs whitespace-nowrap">{lastCycleLabel}</td>
        <td className="py-3">
          <div className="flex flex-nowrap items-center justify-end gap-2">
            <TriggerCycleAction
              onTrigger={runCycle}
              pending={trigger.isPending}
              disabled={!isOperator || globallyPaused || offline || !entry.enabled}
              disabledReason={
                !isOperator
                  ? operatorReason
                  : offline
                    ? "Greenhouse is offline"
                    : globallyPaused
                      ? "Service is globally paused"
                      : "Greenhouse is paused"
              }
            />
            <OptimizerEnableToggle
              enabled={entry.enabled}
              scope="greenhouse"
              onChange={toggle}
              pending={setEnabled.isPending}
              disabled={!isOperator || globallyPaused}
              disabledReason={toggleReason}
            />
          </div>
        </td>
      </tr>
      {!offline ? (
        <tr>
          <td colSpan={4} className="pb-3">
            <PipelineTracker nodes={pipeline} />
          </td>
        </tr>
      ) : null}
    </>
  );
}
