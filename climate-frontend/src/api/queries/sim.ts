import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../client";
import {
  toFleetTimeScaleResult,
  toTimeScale,
  wireFleetTimeScaleResult,
  wireTimeScale,
} from "../schemas";
import { queryKeys } from "./keys";

/**
 * Simulation-only time-scale controls. These relay to the controller's sim clock — a diagnostic,
 * the one explicit exception to setpoint-only downward control (frontend constraints §"Control & safety").
 */

/** Set one greenhouse's simulated-clock speed (0.25–8×). */
export function useSetTimeScale(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (scale: number) =>
      toTimeScale(
        await apiClient.patch(`/greenhouses/${id}/sim/time-scale`, { scale }, wireTimeScale),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.greenhouse(id) });
      return queryClient.invalidateQueries({ queryKey: queryKeys.fleet() });
    },
  });
}

/** Set the whole fleet's simulated-clock speed (fan-out of independent per-controller writes). */
export function useSetFleetTimeScale() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (scale: number) =>
      toFleetTimeScaleResult(
        await apiClient.patch("/sim/time-scale", { scale }, wireFleetTimeScaleResult),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.fleet() }),
  });
}
