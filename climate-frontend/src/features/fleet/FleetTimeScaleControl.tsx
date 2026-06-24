import { useSetFleetTimeScale } from "../../api/queries/sim";
import { TimeScaleControl } from "../../components/ui/TimeScaleControl";
import { useToast } from "../../components/ui/toast-context";

/**
 * The fleet-wide "set all speed" control (interactions §7). The platform fans the write out to N
 * independent per-controller writes; a partial failure (offline / real hardware) is surfaced as a
 * warning toast naming the skipped greenhouses, not a single hard failure.
 */
export function FleetTimeScaleControl({ currentScale }: { currentScale: number | null }) {
  const toast = useToast();
  const mutation = useSetFleetTimeScale();

  return (
    <div className="flex items-center gap-2">
      <span className="text-fg-muted text-sm">Set all speed</span>
      <TimeScaleControl
        value={currentScale}
        pending={mutation.isPending}
        label="Fleet simulation speed"
        onChange={(scale) =>
          mutation.mutate(scale, {
            onSuccess: (result) => {
              const skipped = result.results.filter((entry) => !entry.applied);
              if (skipped.length > 0) {
                toast.push({
                  variant: "warning",
                  title: `Speed set, ${skipped.length} skipped`,
                  message: skipped.map((entry) => entry.greenhouseId).join(", "),
                });
              } else {
                toast.push({ variant: "success", title: `Fleet speed → ${scale}×` });
              }
            },
            onError: (error) =>
              toast.push({
                variant: "warning",
                title: "Couldn't set fleet speed",
                message: error instanceof Error ? error.message : "Unknown error",
              }),
          })
        }
      />
    </div>
  );
}
