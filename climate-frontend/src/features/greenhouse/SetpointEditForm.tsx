import { useEffect, useMemo, useState } from "react";
import { useForm, type Path } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ApiError } from "../../api/client";
import type { Setpoints } from "../../api/schemas";
import { useSetpointEdit } from "../../api/queries/greenhouses";
import { useRole } from "../../hooks/useRole";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/Card";
import { Dialog } from "../../components/ui/Dialog";
import { PanelHeader } from "../../components/ui/PanelHeader";
import { TextField } from "../../components/ui/TextField";
import { useToast } from "../../components/ui/toast-context";

/**
 * The operator's manual setpoint edit (components §3, interactions §7). Validates against the
 * crop-safe bounds the contract enforces, gates the write behind a confirmation dialog summarizing
 * the change, and shows an optimistic-pending → confirmed/rolled-back settle. In 2a this is a thin
 * relay, so when the controller is offline the form disables (there is nothing to queue). Setpoints
 * only — never actuator forcing.
 */
const timePattern = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const schedulePattern = /^([01][0-9]|2[0-3]):[0-5][0-9](,([01][0-9]|2[0-3]):[0-5][0-9])*$/;

const zoneSchema = z
  .object({
    zoneId: z.string(),
    moistureLowThreshold: z.coerce.number().min(0).max(1),
    moistureHighThreshold: z.coerce.number().min(0).max(1),
    drainPeriodSecs: z.coerce.number().int().min(0),
    schedule: z.string().regex(schedulePattern, "HH:MM[,HH:MM…]"),
  })
  .refine((zone) => zone.moistureHighThreshold > zone.moistureLowThreshold, {
    path: ["moistureHighThreshold"],
    message: "High must exceed low",
  });

const formSchema = z
  .object({
    temperatureDayC: z.coerce.number().min(-20).max(60),
    temperatureNightC: z.coerce.number().min(-20).max(60),
    dayStart: z.string().regex(timePattern, "HH:MM"),
    dayEnd: z.string().regex(timePattern, "HH:MM"),
    humidityLowPct: z.coerce.number().min(0).max(100),
    humidityHighPct: z.coerce.number().min(0).max(100),
    humidityDeadbandPct: z.coerce.number().min(0).max(50),
    co2TargetPpm: z.coerce.number().int().min(0).max(5000),
    co2VentInterlockThresholdPct: z.coerce.number().min(0).max(100),
    vpdTargetKpa: z.coerce.number().min(0),
    dliTargetMol: z.coerce.number().min(0),
    zones: z.array(zoneSchema),
  })
  .refine((values) => values.humidityHighPct > values.humidityLowPct, {
    path: ["humidityHighPct"],
    message: "High must exceed low",
  })
  .refine((values) => values.dayEnd > values.dayStart, {
    path: ["dayEnd"],
    message: "Day end must be after day start",
  });

type FormValues = z.infer<typeof formSchema>;

type ScalarKey =
  | "temperatureDayC"
  | "temperatureNightC"
  | "humidityLowPct"
  | "humidityHighPct"
  | "humidityDeadbandPct"
  | "co2TargetPpm"
  | "co2VentInterlockThresholdPct"
  | "vpdTargetKpa"
  | "dliTargetMol";

const SCALAR_FIELDS: { name: ScalarKey; label: string; unit: string; step?: string }[] = [
  { name: "temperatureDayC", label: "Day temperature", unit: "°C", step: "0.1" },
  { name: "temperatureNightC", label: "Night temperature", unit: "°C", step: "0.1" },
  { name: "humidityLowPct", label: "Humidity low", unit: "%RH", step: "1" },
  { name: "humidityHighPct", label: "Humidity high", unit: "%RH", step: "1" },
  { name: "humidityDeadbandPct", label: "Humidity deadband", unit: "%RH", step: "1" },
  { name: "co2TargetPpm", label: "CO₂ target", unit: "ppm", step: "1" },
  { name: "co2VentInterlockThresholdPct", label: "CO₂ vent interlock", unit: "%", step: "1" },
  { name: "vpdTargetKpa", label: "VPD target", unit: "kPa", step: "0.1" },
  { name: "dliTargetMol", label: "DLI target", unit: "mol", step: "0.1" },
];

/** Wire (snake_case) field → form (camelCase) path, for mapping a 422 onto the right input. */
const FIELD_MAP: Record<string, ScalarKey | "dayStart" | "dayEnd"> = {
  temperature_day_c: "temperatureDayC",
  temperature_night_c: "temperatureNightC",
  day_start: "dayStart",
  day_end: "dayEnd",
  humidity_low_pct: "humidityLowPct",
  humidity_high_pct: "humidityHighPct",
  humidity_deadband_pct: "humidityDeadbandPct",
  co2_target_ppm: "co2TargetPpm",
  co2_vent_interlock_threshold_pct: "co2VentInterlockThresholdPct",
  vpd_target_kpa: "vpdTargetKpa",
  dli_target_mol: "dliTargetMol",
};

const DIFF_LABELS: { key: ScalarKey | "dayStart" | "dayEnd"; label: string }[] = [
  ...SCALAR_FIELDS.map((field) => ({ key: field.name, label: field.label })),
  { key: "dayStart", label: "Day start" },
  { key: "dayEnd", label: "Day end" },
];

type Change = { label: string; from: string; to: string };

function diffSetpoints(original: Setpoints, next: FormValues): Change[] {
  const changes: Change[] = [];
  for (const { key, label } of DIFF_LABELS) {
    const before = String(original[key]);
    const after = String(next[key]);
    if (before !== after) changes.push({ label, from: before, to: after });
  }
  if (JSON.stringify(original.zones) !== JSON.stringify(next.zones)) {
    changes.push({ label: "Zone targets", from: "current", to: "updated" });
  }
  return changes;
}

export function SetpointEditForm({
  greenhouseId,
  setpoints,
  offline,
}: {
  greenhouseId: string;
  setpoints: Setpoints;
  offline: boolean;
}) {
  const toast = useToast();
  const { isOperator } = useRole();
  const mutation = useSetpointEdit(greenhouseId);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onBlur",
    defaultValues: setpoints,
  });

  // Re-seed the form when the confirmed server snapshot changes (after a successful edit refetch).
  useEffect(() => {
    reset(setpoints);
  }, [setpoints, reset]);

  const [pending, setPending] = useState<FormValues | null>(null);
  const changes = useMemo(
    () => (pending ? diffSetpoints(setpoints, pending) : []),
    [pending, setpoints],
  );

  // Viewers get a read-only form; operators can edit (unless the controller is offline in 2a).
  const disabled = offline || mutation.isPending || !isOperator;

  const onValid = (values: FormValues) => {
    setPending(values);
  };

  const applyEdit = () => {
    if (!pending) return;
    mutation.mutate(pending, {
      onSuccess: () => {
        toast.push({ variant: "success", title: "Setpoints applied", message: greenhouseId });
        setPending(null);
      },
      onError: (error) => {
        setPending(null);
        if (error instanceof ApiError && error.kind === "validation" && error.validation) {
          const target = FIELD_MAP[error.validation.field];
          if (target) setError(target, { message: error.message });
          else toast.push({ variant: "warning", title: "Edit rejected", message: error.message });
        } else if (error instanceof ApiError && error.kind === "unavailable") {
          toast.push({
            variant: "warning",
            title: "Controller unreachable",
            message: "The edit couldn't be relayed — try again once it reconnects.",
          });
        } else {
          toast.push({
            variant: "warning",
            title: "Edit failed",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      },
    });
  };

  return (
    <Card>
      <PanelHeader title="Setpoints" />
      {!isOperator ? (
        <p
          className="border-border bg-surface-2 text-fg-muted mb-3 rounded-md border px-3 py-2 text-xs"
          role="note"
        >
          Read-only — the operator role is required to edit setpoints.
        </p>
      ) : offline ? (
        <p
          className="border-border bg-surface-2 text-fg-muted mb-3 rounded-md border px-3 py-2 text-xs"
          role="note"
        >
          Controller offline — edits unavailable until it reconnects.
        </p>
      ) : null}

      <form onSubmit={handleSubmit(onValid)} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField
            label="Day start"
            type="time"
            disabled={disabled}
            {...register("dayStart")}
            error={errors.dayStart?.message}
          />
          <TextField
            label="Day end"
            type="time"
            disabled={disabled}
            {...register("dayEnd")}
            error={errors.dayEnd?.message}
          />
          {SCALAR_FIELDS.map((field) => (
            <TextField
              key={field.name}
              label={`${field.label} (${field.unit})`}
              type="number"
              step={field.step}
              disabled={disabled}
              {...register(field.name)}
              error={errors[field.name]?.message}
            />
          ))}
        </div>

        {setpoints.zones.length > 0 ? (
          <div className="flex flex-col gap-3">
            <p className="section-label">Irrigation zones</p>
            {setpoints.zones.map((zone, index) => (
              <div
                key={zone.zoneId}
                className="border-border grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2"
              >
                <p className="text-fg-default text-sm font-medium sm:col-span-2">{zone.zoneId}</p>
                <TextField
                  label="Moisture low (VWC)"
                  type="number"
                  step="0.01"
                  disabled={disabled}
                  {...register(`zones.${index}.moistureLowThreshold` as Path<FormValues>)}
                  error={errors.zones?.[index]?.moistureLowThreshold?.message}
                />
                <TextField
                  label="Moisture high (VWC)"
                  type="number"
                  step="0.01"
                  disabled={disabled}
                  {...register(`zones.${index}.moistureHighThreshold` as Path<FormValues>)}
                  error={errors.zones?.[index]?.moistureHighThreshold?.message}
                />
                <TextField
                  label="Drain period (s)"
                  type="number"
                  step="1"
                  disabled={disabled}
                  {...register(`zones.${index}.drainPeriodSecs` as Path<FormValues>)}
                  error={errors.zones?.[index]?.drainPeriodSecs?.message}
                />
                <TextField
                  label="Schedule (HH:MM,…)"
                  disabled={disabled}
                  {...register(`zones.${index}.schedule` as Path<FormValues>)}
                  error={errors.zones?.[index]?.schedule?.message}
                />
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button
            variant="primary"
            type="submit"
            disabled={disabled}
            title={!isOperator ? "Operator role required" : undefined}
          >
            Review &amp; apply
          </Button>
        </div>
      </form>

      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title="Apply setpoint changes?"
        description={`These targets will be relayed to ${greenhouseId}.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={applyEdit} disabled={mutation.isPending}>
              {mutation.isPending ? "Applying…" : "Apply"}
            </Button>
          </>
        }
      >
        {changes.length === 0 ? (
          <p className="text-fg-muted text-sm">No changes to apply.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {changes.map((change) => (
              <li key={change.label} className="text-sm">
                <span className="text-fg-default font-medium">{change.label}:</span>{" "}
                <span className="text-fg-muted font-mono">{change.from}</span>
                <span className="text-fg-subtle"> → </span>
                <span className="text-fg-default font-mono">{change.to}</span>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </Card>
  );
}
