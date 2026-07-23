import { CirclePause, Lock, Sparkle } from "lucide-react";
import {
  useGreenhouseOptimizerEnabled,
  useOptimizerEnabled,
  useOptimizerEscalations,
  useOptimizerPlan,
  useOptimizerStatus,
  useResolveEscalation,
  useSetGreenhouseOptimizerEnabled,
  useTriggerOptimizerCycle,
} from "../../api/queries/optimizer";
import { useRole } from "../../hooks/useRole";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/Card";
import { PanelHeader } from "../../components/ui/PanelHeader";
import { Pill } from "../../components/ui/Pill";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/toast-context";
import { PlanOutcomeBadge, ReasonCodeChip } from "./badges";
import { OptimizerEnableToggle, TriggerCycleAction } from "./controls";
import { SetpointDiffTable } from "./SetpointDiffTable";
import { optimizerActionError } from "./errors";

const MUTED = "var(--color-status-offline)";

/**
 * The per-greenhouse half of the optimizer console (hybrid split): the latest cycle for one
 * greenhouse on its detail view — outcome + reason, confidence, explanation, backend provenance, and
 * the proposed-vs-current setpoint diff — plus the per-greenhouse pause/resume, on-demand trigger,
 * and (when escalated) resolve. Absent entirely when the optimizer is unreachable/undeployed.
 */
export function OptimizerPlanPanel({
  greenhouseId,
  displayName,
}: {
  greenhouseId: string;
  displayName: string;
}) {
  const status = useOptimizerStatus();
  const serviceEnabledQuery = useOptimizerEnabled();
  const ghEnabledQuery = useGreenhouseOptimizerEnabled(greenhouseId);
  const planQuery = useOptimizerPlan(greenhouseId);
  const escalations = useOptimizerEscalations();
  const { isOperator } = useRole();
  const toast = useToast();
  const trigger = useTriggerOptimizerCycle(greenhouseId);
  const setEnabled = useSetGreenhouseOptimizerEnabled(greenhouseId);
  const resolve = useResolveEscalation();

  // The optimizer isn't reachable / deployed — the panel is absent rather than a broken card.
  if (status.data?.status === "unavailable") return null;
  if (status.isLoading) {
    return (
      <Card>
        <PanelHeader title="Optimizer" sectionLabel titleSize="large" />
        <Skeleton height={120} />
      </Card>
    );
  }

  const serviceEnabled = serviceEnabledQuery.data?.enabled ?? status.data?.enabled ?? true;
  const greenhouseEnabled = ghEnabledQuery.data?.enabled ?? true;
  const globallyPaused = !serviceEnabled;
  const operatorReason = isOperator ? undefined : "Operator role required";

  const openEscalation = (escalations.data ?? []).find((e) => e.greenhouseId === greenhouseId);

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

  const resolveEscalation = () => {
    if (!openEscalation) return;
    resolve.mutate(
      { escalationId: openEscalation.id },
      {
        onSuccess: () =>
          toast.push({ variant: "success", title: "Escalation resolved", message: displayName }),
        onError: (error) =>
          toast.push({
            variant: "warning",
            title: "Couldn't resolve",
            message: optimizerActionError(error, "Resolve failed"),
          }),
      },
    );
  };

  // Header pill: global pause wins (Read-only), then this greenhouse's own pause (Disabled).
  const headerPill = globallyPaused ? (
    <Pill color={MUTED} icon={<Lock size={12} aria-hidden />}>
      Read-only
    </Pill>
  ) : !greenhouseEnabled ? (
    <Pill color={MUTED} icon={<CirclePause size={12} aria-hidden />}>
      Disabled
    </Pill>
  ) : (
    <Pill color="var(--color-status-online)" icon={<Sparkle size={12} aria-hidden />}>
      Enabled
    </Pill>
  );

  const detail = planQuery.data;
  const escalated = detail?.plan.outcome.status === "escalated";

  return (
    <Card>
      <PanelHeader
        title="Optimizer"
        sectionLabel
        titleSize="large"
        actions={
          <OptimizerEnableToggle
            enabled={greenhouseEnabled}
            scope="greenhouse"
            onChange={toggle}
            pending={setEnabled.isPending}
            disabled={!isOperator || globallyPaused}
            disabledReason={
              !isOperator
                ? operatorReason
                : globallyPaused
                  ? "Service is globally paused"
                  : undefined
            }
          />
        }
      />

      <div className="mb-3">{headerPill}</div>

      {planQuery.isLoading ? (
        <Skeleton height={120} />
      ) : !detail ? (
        <p className="text-fg-subtle text-sm">
          No optimizer plan yet — the first cycle hasn't run.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <PlanOutcomeBadge status={detail.plan.outcome.status} />
            {escalated && detail.plan.outcome.reasonCode ? (
              <ReasonCodeChip
                code={detail.plan.outcome.reasonCode}
                reasonClass={openEscalation?.reasonClass}
              />
            ) : null}
          </div>

          {detail.plan.outcome.message ? (
            <p className="text-fg-muted text-sm">{detail.plan.outcome.message}</p>
          ) : null}

          {detail.plan.plan ? (
            <>
              <p className="text-fg-default text-sm">{detail.plan.plan.explanation}</p>
              <div className="text-fg-muted flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span>Confidence {Math.round(detail.plan.plan.confidence * 100)}%</span>
                <span>
                  {detail.plan.backend.provider} · {detail.plan.backend.model} ·{" "}
                  {detail.plan.backend.promptVersion} · {detail.plan.backend.role}
                </span>
              </div>
              {detail.diff ? (
                <SetpointDiffTable diff={detail.diff} />
              ) : (
                <p className="text-fg-subtle text-sm">Cycle ran; nothing applied.</p>
              )}
            </>
          ) : (
            <p className="text-fg-subtle text-sm">Cycle ran; nothing applied.</p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <TriggerCycleAction
              onTrigger={runCycle}
              pending={trigger.isPending}
              disabled={!isOperator || globallyPaused || !greenhouseEnabled}
              disabledReason={
                !isOperator
                  ? operatorReason
                  : globallyPaused
                    ? "Service is globally paused"
                    : "Greenhouse is paused"
              }
            />
            {escalated ? (
              <Button
                variant="secondary"
                onClick={resolveEscalation}
                disabled={!isOperator || resolve.isPending || !openEscalation}
                title={
                  !isOperator ? operatorReason : !openEscalation ? "No open escalation" : undefined
                }
              >
                {resolve.isPending ? "Resolving…" : "Resolve"}
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </Card>
  );
}
