import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../client";
import {
  toCycleAccepted,
  toEnableState,
  toEscalation,
  toFleetOptimizerSummary,
  toGreenhouseEnableState,
  toModelState,
  toOptimizerPlanDetail,
  toOptimizerStatus,
  wireCycleAccepted,
  wireEnableState,
  wireEscalation,
  wireEscalationList,
  wireFleetOptimizerSummary,
  wireGreenhouseEnableState,
  wireModelState,
  wireOptimizerPlanDetail,
  wireOptimizerStatus,
} from "../schemas";
import { queryKeys } from "./keys";

/**
 * Phase 3 optimizer console data access. The Go API proxies/aggregates the optimizer's own Service
 * API into the versioned dashboard surface; the SPA reaches the optimizer only through here
 * (optimizer interfaces §The operator dashboard reaches this surface through the platform Go API).
 *
 * Every read is **polled** (no WebSocket — architecture §Optimizer console): plans move on the
 * optimizer's fixed cadence, and status/enable/escalation state reflects operator actions that
 * should surface within a poll. Reads stay open; the mutations are operator-gated (the Go API
 * forwards the caller's token so the optimizer re-checks the role in oidc mode).
 */
export const OPTIMIZER_POLL_MS = 15 * 1000;

/** Service-health badge — the Go API's derivation of the optimizer's internal /health. Always renders
 *  (the Go API synthesizes `unavailable` rather than a proxy 5xx), so this read is not gated on an id. */
export function useOptimizerStatus() {
  return useQuery({
    queryKey: queryKeys.optimizerStatus(),
    queryFn: async () =>
      toOptimizerStatus(await apiClient.get("/optimizer/status", wireOptimizerStatus)),
    refetchInterval: OPTIMIZER_POLL_MS,
    retry: false,
  });
}

/** Fleet rollup — per-greenhouse latest outcome + site aggregates. Shared by the console table and
 *  each fleet card's optimizer pill. 404s (or errors) when the optimizer is not deployed → callers
 *  treat the absence as "no optimizer" rather than a failure. */
export function useOptimizerFleet() {
  return useQuery({
    queryKey: queryKeys.optimizerFleet(),
    queryFn: async () =>
      toFleetOptimizerSummary(await apiClient.get("/optimizer/fleet", wireFleetOptimizerSummary)),
    refetchInterval: OPTIMIZER_POLL_MS,
    retry: false,
  });
}

/** The open-escalation worklist (held cycles awaiting review). */
export function useOptimizerEscalations() {
  return useQuery({
    queryKey: queryKeys.optimizerEscalations(),
    queryFn: async () =>
      (await apiClient.get("/optimizer/escalations", wireEscalationList)).map(toEscalation),
    refetchInterval: OPTIMIZER_POLL_MS,
    retry: false,
  });
}

/** The active backend + the active provider's runtime allowlist (the `ModelSelector` source). */
export function useOptimizerModel() {
  return useQuery({
    queryKey: queryKeys.optimizerModel(),
    queryFn: async () => toModelState(await apiClient.get("/optimizer/model", wireModelState)),
    refetchInterval: OPTIMIZER_POLL_MS,
    retry: false,
  });
}

/** The service-wide enable / read-only state. */
export function useOptimizerEnabled() {
  return useQuery({
    queryKey: queryKeys.optimizerEnabled(),
    queryFn: async () => toEnableState(await apiClient.get("/optimizer/enabled", wireEnableState)),
    refetchInterval: OPTIMIZER_POLL_MS,
    retry: false,
  });
}

/** One greenhouse's latest plan view + the Go-API-composed setpoint diff (the detail plan panel). */
export function useOptimizerPlan(greenhouseId: string) {
  return useQuery({
    queryKey: queryKeys.optimizerPlan(greenhouseId),
    queryFn: async () =>
      toOptimizerPlanDetail(
        await apiClient.get(`/optimizer/greenhouses/${greenhouseId}/plan`, wireOptimizerPlanDetail),
      ),
    enabled: greenhouseId.length > 0,
    refetchInterval: OPTIMIZER_POLL_MS,
    // A greenhouse with no plan yet (cold start) returns 404 — treat that as "no plan", not an error.
    retry: false,
  });
}

/** One greenhouse's per-greenhouse enable state (the detail panel toggle). */
export function useGreenhouseOptimizerEnabled(greenhouseId: string) {
  return useQuery({
    queryKey: queryKeys.optimizerGreenhouseEnabled(greenhouseId),
    queryFn: async () =>
      toGreenhouseEnableState(
        await apiClient.get(
          `/optimizer/greenhouses/${greenhouseId}/enabled`,
          wireGreenhouseEnableState,
        ),
      ),
    enabled: greenhouseId.length > 0,
    refetchInterval: OPTIMIZER_POLL_MS,
    retry: false,
  });
}

// --- Operator mutations --------------------------------------------------------------------

/** Resolve an open escalation (the `operator` resolution). Refreshes the worklist and the fleet. */
export function useResolveEscalation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ escalationId, reason }: { escalationId: string; reason?: string }) =>
      toEscalation(
        await apiClient.post(
          `/optimizer/escalations/${escalationId}/resolve`,
          { reason },
          wireEscalation,
        ),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.optimizerEscalations() });
      return queryClient.invalidateQueries({ queryKey: queryKeys.optimizerFleet() });
    },
  });
}

/** Switch the active planning model within the provider's allowlist (takes effect next cycle). */
export function useSetOptimizerModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ model, reason }: { model: string; reason?: string }) =>
      toModelState(await apiClient.post("/optimizer/model", { model, reason }, wireModelState)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.optimizerModel() }),
  });
}

/** Pause / resume planning service-wide (read-only mode). Refreshes the enable state and the badge. */
export function useSetOptimizerEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ enabled, reason }: { enabled: boolean; reason?: string }) =>
      toEnableState(
        await apiClient.post("/optimizer/enabled", { enabled, reason }, wireEnableState),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.optimizerEnabled() });
      queryClient.invalidateQueries({ queryKey: queryKeys.optimizerStatus() });
      return queryClient.invalidateQueries({ queryKey: queryKeys.optimizerFleet() });
    },
  });
}

/** Trigger an on-demand cycle for one greenhouse (202). Refreshes its plan, the fleet, and the worklist. */
export function useTriggerOptimizerCycle(greenhouseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ reason }: { reason?: string } = {}) =>
      toCycleAccepted(
        await apiClient.post(
          `/optimizer/greenhouses/${greenhouseId}/cycles`,
          { reason },
          wireCycleAccepted,
        ),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.optimizerPlan(greenhouseId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.optimizerEscalations() });
      return queryClient.invalidateQueries({ queryKey: queryKeys.optimizerFleet() });
    },
  });
}

/** Pause / resume planning for one greenhouse. Refreshes its enable state and the fleet. */
export function useSetGreenhouseOptimizerEnabled(greenhouseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ enabled, reason }: { enabled: boolean; reason?: string }) =>
      toGreenhouseEnableState(
        await apiClient.post(
          `/optimizer/greenhouses/${greenhouseId}/enabled`,
          { enabled, reason },
          wireGreenhouseEnableState,
        ),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.optimizerGreenhouseEnabled(greenhouseId),
      });
      return queryClient.invalidateQueries({ queryKey: queryKeys.optimizerFleet() });
    },
  });
}
