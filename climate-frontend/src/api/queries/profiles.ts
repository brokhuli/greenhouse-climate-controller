import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../client";
import {
  toAssignment,
  toCropProfile,
  toWireAssignmentInput,
  toWireCropProfile,
  toWireCropProfilePatch,
  wireAssignment,
  wireCropProfile,
  wireProfileLibrary,
  type AssignmentInput,
  type CropProfile,
} from "../schemas";
import { queryKeys } from "./keys";

/** The crop-profile library (2b). */
export function useProfiles() {
  return useQuery({
    queryKey: queryKeys.profiles(),
    queryFn: async () => (await apiClient.get("/profiles", wireProfileLibrary)).map(toCropProfile),
  });
}

/** One crop profile including its stage-aware target bundles. */
export function useProfile(id: string) {
  return useQuery({
    queryKey: queryKeys.profile(id),
    queryFn: async () => toCropProfile(await apiClient.get(`/profiles/${id}`, wireCropProfile)),
    enabled: id.length > 0,
  });
}

/** Create a crop profile. Refreshes the library on success. */
export function useCreateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (profile: CropProfile) =>
      toCropProfile(await apiClient.post("/profiles", toWireCropProfile(profile), wireCropProfile)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.profiles() }),
  });
}

/** Edit a crop profile (id is immutable). Refreshes the library and that profile. */
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (profile: CropProfile) =>
      toCropProfile(
        await apiClient.patch(
          `/profiles/${profile.id}`,
          toWireCropProfilePatch(profile),
          wireCropProfile,
        ),
      ),
    onSuccess: (profile) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.profile(profile.id) });
      return queryClient.invalidateQueries({ queryKey: queryKeys.profiles() });
    },
  });
}

/** Delete a crop profile. Refreshes the library. */
export function useDeleteProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/profiles/${id}`),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.profile(id) });
      return queryClient.invalidateQueries({ queryKey: queryKeys.profiles() });
    },
  });
}

/** A greenhouse's current profile/stage assignment (2b). */
export function useAssignment(greenhouseId: string) {
  return useQuery({
    queryKey: queryKeys.assignment(greenhouseId),
    queryFn: async () =>
      toAssignment(await apiClient.get(`/greenhouses/${greenhouseId}/assignment`, wireAssignment)),
    enabled: greenhouseId.length > 0,
    // A greenhouse with no assignment yet returns 404 — treat that as "no assignment", not an error.
    retry: false,
  });
}

/**
 * Assign a profile/stage to a greenhouse (PUT) — the platform resolves the stage targets and
 * applies them through reconciliation. Refreshes the assignment, the greenhouse detail (drift/
 * setpoints), and the fleet.
 */
export function useSetAssignment(greenhouseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AssignmentInput) =>
      toAssignment(
        await apiClient.put(
          `/greenhouses/${greenhouseId}/assignment`,
          toWireAssignmentInput(input),
          wireAssignment,
        ),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.assignment(greenhouseId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.greenhouse(greenhouseId) });
      return queryClient.invalidateQueries({ queryKey: queryKeys.fleet() });
    },
  });
}
