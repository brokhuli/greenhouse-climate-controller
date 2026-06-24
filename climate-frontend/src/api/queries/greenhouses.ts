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
import { queryKeys } from "./keys";

/** Fleet list — the landing view's source, patched live by `status`/`drift` frames. */
export function useFleet() {
  return useQuery({
    queryKey: queryKeys.fleet(),
    queryFn: async () => (await apiClient.get("/greenhouses", wireFleet)).map(toGreenhouseSummary),
  });
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
