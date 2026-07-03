import { useSetTimeScale } from "../../api/queries/sim";
import { useRole } from "../../hooks/useRole";
import { TimeScaleControl } from "../../components/ui/TimeScaleControl";
import { useToast } from "../../components/ui/toast-context";

/**
 * The per-greenhouse live simulation-speed knob (interactions §7). Writes immediately with no
 * confirmation; the observed `scale` comes from the `status` frame (kept on the detail snapshot),
 * so the badge stays correct even if the speed is changed elsewhere. A write failure rolls back to
 * that observed value and toasts.
 */
export function GreenhouseTimeScaleControl({
  greenhouseId,
  scale,
}: {
  greenhouseId: string;
  scale: number | null;
}) {
  const toast = useToast();
  const { isOperator } = useRole();
  const mutation = useSetTimeScale(greenhouseId);

  return (
    <TimeScaleControl
      value={scale}
      pending={mutation.isPending}
      disabled={!isOperator}
      onChange={(next) =>
        mutation.mutate(next, {
          onError: (error) =>
            toast.push({
              variant: "warning",
              title: "Couldn't change speed",
              message: error instanceof Error ? error.message : "Unknown error",
            }),
        })
      }
    />
  );
}
