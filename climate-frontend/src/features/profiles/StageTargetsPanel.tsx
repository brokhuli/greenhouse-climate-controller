import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";
import type { ProfileStage } from "../../api/schemas";
import { Card } from "../../components/Card";
import { climateTargetRows, dayWindow, fmt } from "./stageTargets";

type TargetsTab = "climate" | "irrigation";

/**
 * The stage-targets detail pane (profiles §master–detail, right column): a stepper across the selected
 * profile's stages plus the full climate and per-zone irrigation targets for the current stage. Read-
 * only — editing stays in the ProfileEditForm dialog.
 */
export function StageTargetsPanel({
  stage,
  stageIndex,
  stageCount,
  onStep,
}: {
  stage: ProfileStage;
  stageIndex: number;
  stageCount: number;
  onStep: (index: number) => void;
}) {
  const [tab, setTab] = useState<TargetsTab>("climate");
  const rows = climateTargetRows(stage.targets, stage.bounds);
  const zones = stage.targets.zones;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="section-label">Stage targets</p>
          <p className="text-fg-default truncate text-base font-semibold capitalize">
            {stage.stage}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <StepButton
            label="Previous stage"
            disabled={stageIndex === 0}
            onClick={() => onStep(stageIndex - 1)}
          >
            <ChevronLeft size={16} aria-hidden />
          </StepButton>
          <span className="text-fg-muted text-xs tabular-nums">
            {stageIndex + 1} / {stageCount}
          </span>
          <StepButton
            label="Next stage"
            disabled={stageIndex >= stageCount - 1}
            onClick={() => onStep(stageIndex + 1)}
          >
            <ChevronRight size={16} aria-hidden />
          </StepButton>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Stage targets"
        className="border-border mb-3 flex gap-1 border-b"
      >
        <TabButton active={tab === "climate"} onClick={() => setTab("climate")}>
          Climate
        </TabButton>
        <TabButton active={tab === "irrigation"} onClick={() => setTab("irrigation")}>
          Irrigation{zones.length > 0 ? ` (${zones.length})` : ""}
        </TabButton>
      </div>

      {tab === "climate" ? (
        <ul className="flex flex-col">
          <li className="border-divider flex items-center justify-between gap-3 border-b py-2">
            <span className="flex min-w-0 items-center gap-2">
              <IconBadge colorVar="--color-fg-muted">
                <Clock size={15} aria-hidden />
              </IconBadge>
              <span className="text-fg-default truncate text-sm">Daylight window</span>
            </span>
            <span className="text-fg-default font-mono text-sm tabular-nums">
              {dayWindow(stage.targets)}
            </span>
          </li>
          {rows.map((row) => (
            <li
              key={row.key}
              className="border-divider flex items-center justify-between gap-3 border-b py-2 last:border-b-0"
            >
              <span className="flex min-w-0 items-center gap-2">
                <IconBadge colorVar={row.colorVar}>
                  <row.Icon size={15} aria-hidden />
                </IconBadge>
                <span className="text-fg-default truncate text-sm">{row.label}</span>
              </span>
              <span className="shrink-0 text-right">
                <span>
                  <span className="text-fg-default font-mono text-sm font-semibold tabular-nums">
                    {row.value}
                  </span>
                  <span className="text-fg-muted text-xs"> {row.unit}</span>
                </span>
                {row.range ? (
                  <span className="text-fg-subtle block text-xs tabular-nums">
                    safe {row.range}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : zones.length === 0 ? (
        <p className="text-fg-subtle text-sm">No irrigation zones for this stage.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-fg-subtle text-left">
                <th className="section-label py-1 font-normal">Zone</th>
                <th className="section-label py-1 text-right font-normal">Moist. min</th>
                <th className="section-label py-1 text-right font-normal">Moist. max</th>
                <th className="section-label py-1 text-right font-normal">Drain</th>
                <th className="section-label py-1 text-right font-normal">Schedule</th>
              </tr>
            </thead>
            <tbody>
              {zones.map((zone) => (
                <tr key={zone.zoneId} className="border-divider border-t">
                  <td className="text-fg-default py-1.5">{zone.zoneId}</td>
                  <td className="text-fg-muted py-1.5 text-right tabular-nums">
                    {fmt(zone.moistureLowThreshold)}
                  </td>
                  <td className="text-fg-muted py-1.5 text-right tabular-nums">
                    {fmt(zone.moistureHighThreshold)}
                  </td>
                  <td className="text-fg-muted py-1.5 text-right tabular-nums">
                    {fmt(zone.drainPeriodSecs)}s
                  </td>
                  <td className="text-fg-muted py-1.5 text-right tabular-nums">{zone.schedule}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function IconBadge({ colorVar, children }: { colorVar: string; children: ReactNode }) {
  return (
    <span
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
      style={{
        backgroundColor: `color-mix(in srgb, var(${colorVar}) 14%, transparent)`,
        color: `var(${colorVar})`,
      }}
      aria-hidden
    >
      {children}
    </span>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="border-border bg-surface-1 text-fg-muted hover:bg-surface-3 hover:text-fg-default inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors duration-[var(--motion-instant)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`-mb-px border-b-2 px-1 pb-2 text-sm font-medium transition-colors duration-[var(--motion-instant)] ${
        active
          ? "border-accent text-fg-default"
          : "text-fg-muted hover:text-fg-default border-transparent"
      }`}
    >
      {children}
    </button>
  );
}
