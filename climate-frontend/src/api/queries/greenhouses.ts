import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../client";
import {
  toGreenhouseDetail,
  toGreenhouseSummary,
  toSetpoints,
  toWireRegistration,
  toWireSetpointsPatch,
  wireFleet,
  wireGreenhouseDetail,
  wireGreenhouseSummary,
  wireSetpoints,
  type GreenhouseRegistrationInput,
  type SetpointsPatch,
} from "../schemas";
import { FLEET_POLL_BASE_MS } from "./fleet";
import { queryKeys } from "./keys";

/**
 * Fleet list — the landing view's source. `status`/`drift`/telemetry frames patch it live between
 * refreshes, but `climate.dli` has no live carrier (it's a backend accumulator served only on this
 * REST snapshot, not a WS telemetry metric), so a periodic refetch is what keeps DLI current without
 * a page reload. Cadence tracks the sparkline poll's base interval.
 *
 * That refetch is driven by our own interval rather than useQuery's `refetchInterval` on purpose:
 * the live stream patches this same fleet query via `setQueryData` on nearly every telemetry frame
 * (see livePatch.ts), and each cache write makes React Query clear and recreate the observer's
 * refetch-interval timer. At a sub-60s frame cadence the timer is perpetually reset and never fires,
 * so DLI froze until a full page reload. A self-owned interval isn't tied to the observer, so those
 * cache writes can't starve it.
 */
export function useFleet() {
  const queryClient = useQueryClient();
  const result = useQuery({
    queryKey: queryKeys.fleet(),
    queryFn: async () => (await apiClient.get("/greenhouses", wireFleet)).map(toGreenhouseSummary),
  });

  useEffect(() => {
    const timer = setInterval(() => {
      void queryClient.refetchQueries({ queryKey: queryKeys.fleet() });
    }, FLEET_POLL_BASE_MS);
    return () => clearInterval(timer);
  }, [queryClient]);

  return result;
}

/** One greenhouse's detail snapshot, including its current setpoints. */
export function useGreenhouse(id: string) {
  return useQuery({
    queryKey: queryKeys.greenhouse(id),
    queryFn: async () =>
      toGreenhouseDetail(await apiClient.get(`/greenhouses/${id}`, wireGreenhouseDetail)),
    enabled: id.length > 0,
  });
}

/** Register a greenhouse into the fleet. Invalidates the fleet list on success. */
export function useRegisterGreenhouse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: GreenhouseRegistrationInput) =>
      toGreenhouseSummary(
        await apiClient.post("/greenhouses", toWireRegistration(input), wireGreenhouseSummary),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.fleet() }),
  });
}

/** Retire a greenhouse. Drops its detail cache and refreshes the fleet. */
export function useRetireGreenhouse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/greenhouses/${id}`),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.greenhouse(id) });
      return queryClient.invalidateQueries({ queryKey: queryKeys.fleet() });
    },
  });
}

/** Ad-hoc setpoint edit (2a relay to the controller). Refreshes the greenhouse + fleet. */
export function useSetpointEdit(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: SetpointsPatch) =>
      toSetpoints(
        await apiClient.patch(
          `/greenhouses/${id}/setpoints`,
          toWireSetpointsPatch(patch),
          wireSetpoints,
        ),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.greenhouse(id) });
      return queryClient.invalidateQueries({ queryKey: queryKeys.fleet() });
    },
  });
}
