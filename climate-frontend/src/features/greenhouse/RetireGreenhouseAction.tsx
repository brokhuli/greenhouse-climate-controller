import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Trash2 } from "lucide-react";
import { useRetireGreenhouse } from "../../api/queries/greenhouses";
import { useRole } from "../../hooks/useRole";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { useToast } from "../../components/ui/toast-context";
import { formatGreenhouseLabel } from "../../lib/derivations";

/**
 * Remove a greenhouse from the fleet (components §3) — a danger confirm. On success the fleet is
 * refreshed, the detail cache dropped (by the mutation), and the operator returned to the fleet.
 * Only the registry entry is removed; stored history is retained.
 */
export function RetireGreenhouseAction({
  greenhouseId,
  displayName,
}: {
  greenhouseId: string;
  displayName: string;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();
  const { isOperator } = useRole();
  const mutation = useRetireGreenhouse();
  const name = formatGreenhouseLabel(displayName);

  const confirm = () =>
    mutation.mutate(greenhouseId, {
      onSuccess: () => {
        toast.push({ variant: "success", title: "Greenhouse retired", message: name });
        setOpen(false);
        navigate("/");
      },
      onError: (error) =>
        toast.push({
          variant: "warning",
          title: "Couldn't retire greenhouse",
          message: error instanceof Error ? error.message : "Unknown error",
        }),
    });

  return (
    <>
      <Button
        variant="ghost"
        onClick={() => setOpen(true)}
        disabled={!isOperator}
        title={isOperator ? undefined : "Operator role required"}
      >
        <Trash2 size={14} aria-hidden />
        Retire
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Retire ${name}?`}
        description="Removes the registry entry. Stored history is retained."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirm} disabled={mutation.isPending}>
              {mutation.isPending ? "Retiring…" : "Retire"}
            </Button>
          </>
        }
      >
        <p className="text-fg-muted text-sm">
          The platform will stop tracking{" "}
          <span className="text-fg-default font-medium">{name}</span> ({greenhouseId}).
        </p>
      </Dialog>
    </>
  );
}
