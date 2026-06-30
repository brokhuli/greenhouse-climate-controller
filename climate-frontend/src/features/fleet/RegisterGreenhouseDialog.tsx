import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ApiError } from "../../api/client";
import type { GreenhouseRegistrationInput } from "../../api/schemas";
import { useRegisterGreenhouse } from "../../api/queries/greenhouses";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { TextField } from "../../components/ui/TextField";
import { useToast } from "../../components/ui/toast-context";
import { formatGreenhouseLabel } from "../../lib/derivations";

/**
 * Add a greenhouse to the fleet (components §3). A modal form, not a route — writes are in-view
 * affordances. The controller endpoint is registration-time config the platform needs to reach the
 * controller; the SPA never speaks it directly. A 422 maps to inline field errors.
 */
const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const formSchema = z.object({
  id: z.string().regex(slugPattern, "Lowercase kebab slug, e.g. gh-a"),
  displayName: z.string().min(1, "Required"),
  crop: z.string().optional(),
  controller: z.object({
    restBaseUrl: z.string().url("Must be a URL, e.g. http://gh-a:8080"),
    mqttTopicRoot: z.string().min(1, "Required"),
  }),
});

type FormValues = z.infer<typeof formSchema>;

type RegisterPath =
  | "id"
  | "displayName"
  | "crop"
  | "controller.restBaseUrl"
  | "controller.mqttTopicRoot";

/** API (wire, snake_case) field names → react-hook-form (camelCase) paths for 422 mapping. */
const FIELD_MAP: Record<string, RegisterPath> = {
  id: "id",
  display_name: "displayName",
  crop: "crop",
  "controller.rest_base_url": "controller.restBaseUrl",
  "controller.mqtt_topic_root": "controller.mqttTopicRoot",
};

export function RegisterGreenhouseDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const mutation = useRegisterGreenhouse();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onBlur",
    defaultValues: {
      id: "",
      displayName: "",
      crop: "",
      controller: { restBaseUrl: "", mqttTopicRoot: "" },
    },
  });

  const close = () => {
    reset();
    onClose();
  };

  const onSubmit = handleSubmit(
    (values) =>
      new Promise<void>((resolve) => {
        const input: GreenhouseRegistrationInput = {
          id: values.id,
          displayName: values.displayName,
          crop: values.crop?.trim() ? values.crop.trim() : null,
          controller: {
            restBaseUrl: values.controller.restBaseUrl,
            mqttTopicRoot: values.controller.mqttTopicRoot,
          },
        };
        mutation.mutate(input, {
          onSuccess: (created) => {
            toast.push({
              variant: "success",
              title: "Greenhouse registered",
              message: formatGreenhouseLabel(created.displayName),
            });
            reset();
            onClose();
            resolve();
          },
          onError: (error) => {
            if (error instanceof ApiError && error.kind === "validation" && error.validation) {
              const target = FIELD_MAP[error.validation.field];
              if (target) setError(target, { message: error.message });
              else
                toast.push({
                  variant: "warning",
                  title: "Registration rejected",
                  message: error.message,
                });
            } else {
              toast.push({
                variant: "warning",
                title: "Registration failed",
                message: error instanceof Error ? error.message : "Unknown error",
              });
            }
            resolve();
          },
        });
      }),
  );

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Register greenhouse"
      description="The controller endpoint is how the platform reaches the controller — the dashboard never speaks it directly."
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="register-greenhouse-form"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Registering…" : "Register"}
          </Button>
        </>
      }
    >
      <form id="register-greenhouse-form" onSubmit={onSubmit} className="flex flex-col gap-3">
        <TextField
          label="ID (slug)"
          {...register("id")}
          error={errors.id?.message}
          hint="Lowercase kebab, reused across MQTT / REST / DB"
          placeholder="gh-a"
        />
        <TextField
          label="Display name"
          {...register("displayName")}
          error={errors.displayName?.message}
          placeholder="Greenhouse A"
        />
        <TextField
          label="Crop (optional)"
          {...register("crop")}
          error={errors.crop?.message}
          placeholder="lettuce"
        />
        <TextField
          label="Controller REST URL"
          {...register("controller.restBaseUrl")}
          error={errors.controller?.restBaseUrl?.message}
          placeholder="http://gh-a:8080"
        />
        <TextField
          label="Controller MQTT topic root"
          {...register("controller.mqttTopicRoot")}
          error={errors.controller?.mqttTopicRoot?.message}
          placeholder="gh/gh-a"
        />
      </form>
    </Dialog>
  );
}
