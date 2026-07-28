import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Fragment } from "react";
import type { PipelineNode, PipelineNodeState } from "./pipeline";

/**
 * The per-greenhouse pipeline tracker on the optimizer console: a horizontal six-node stepper
 * (Ingest → … → Publish) showing where a cycle is (live) or where the last one stopped. Colour
 * follows the console's grammar (green done, accent active, orange failed, blue held, muted pending);
 * text always carries the meaning, so it is never colour-only. Driven by the pure `pipelineStages`
 * derivation.
 */

// Reuse the fleet's colour tokens: done = healthy green, failed = the escalated orange, held = the
// extended blue, and pending/idle the muted offline grey. Active is the accent — a cycle at work.
const DONE = "var(--color-status-online)";
const ACTIVE = "var(--color-accent)";
const FAILED = "var(--color-status-degraded)";
const HELD = "var(--color-info)";
const MUTED = "var(--color-status-offline)";

const NODE_META: Record<
  PipelineNodeState,
  { color: string; Icon: LucideIcon; spin?: boolean; word: string }
> = {
  done: { color: DONE, Icon: CircleCheck, word: "done" },
  active: { color: ACTIVE, Icon: LoaderCircle, spin: true, word: "running" },
  failed: { color: FAILED, Icon: TriangleAlert, word: "failed here" },
  held: { color: HELD, Icon: CircleMinus, word: "held here" },
  pending: { color: MUTED, Icon: CircleDashed, word: "pending" },
  idle: { color: MUTED, Icon: CircleDashed, word: "idle" },
};

export function PipelineTracker({ nodes }: { nodes: PipelineNode[] }) {
  return (
    <ol
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1"
      aria-label="Optimizer pipeline progress"
    >
      {nodes.map((node, i) => {
        const meta = NODE_META[node.state];
        const Icon = meta.Icon;
        return (
          <Fragment key={node.stage}>
            {i > 0 && (
              <span
                aria-hidden
                className="h-px w-4 shrink-0"
                style={{ backgroundColor: nodes[i - 1].state === "done" ? DONE : MUTED }}
              />
            )}
            <li
              className="inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap"
              style={{ color: meta.color }}
              title={
                node.message
                  ? `${node.label} — ${meta.word}: ${node.message}`
                  : `${node.label} — ${meta.word}`
              }
            >
              <Icon size={13} aria-hidden className={meta.spin ? "animate-spin" : undefined} />
              {node.label}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
