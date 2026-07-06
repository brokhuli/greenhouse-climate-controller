import type { z } from "zod";
import { wireErrorBody, wireValidationError } from "./schemas";
import { getAccessToken, handleUnauthorized } from "./authToken";

/**
 * The single REST client for the SPA. Every request/response shape is validated against the
 * Zod schemas in `schemas.ts` (which mirror `contracts/frontend-rest/`). Nothing outside
 * `src/api/` calls `fetch` directly (architecture §2, boundary 1).
 *
 * Base URL: empty by default — the SPA is same-origin with the API in both dev (Vite proxies
 * `/api` to :8080) and prod (nginx serves the SPA and proxies `/api`). `VITE_API_BASE` is the
 * deployment-supplied override (constraints: "API base supplied by the deployment, not hardcoded").
 */

export type ApiErrorKind =
  | "validation" // 422 — a write violated a field bound
  | "not_found" // 404
  | "unavailable" // 503 — controller unreachable (live detail read)
  | "client" // other 4xx
  | "server" // 5xx
  | "network" // request never completed
  | "parse"; // response did not match the contract schema

export type ValidationDetail = { field: string; bound: string; value?: unknown };

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly validation?: ValidationDetail;

  constructor(
    kind: ApiErrorKind,
    message: string,
    options?: { status?: number; validation?: ValidationDetail; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ApiError";
    this.kind = kind;
    this.status = options?.status;
    this.validation = options?.validation;
  }
}

/** The HTTP status carried by an `ApiError`, or `undefined` for non-HTTP failures (network/parse). */
export const getHttpStatus = (error: unknown): number | undefined =>
  error instanceof ApiError ? error.status : undefined;

const apiBase = (): string => import.meta.env.VITE_API_BASE ?? "";

const url = (path: string): string => `${apiBase()}/api${path}`;

type RequestInit = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown };

const errorKindForStatus = (status: number): ApiErrorKind => {
  if (status === 404) return "not_found";
  if (status === 503) return "unavailable";
  if (status >= 500) return "server";
  return "client";
};

const parseError = async (response: Response): Promise<ApiError> => {
  const status = response.status;
  let payload: unknown = undefined;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON error body — fall through to a status-only message.
  }

  if (status === 422) {
    const validation = wireValidationError.safeParse(payload);
    if (validation.success) {
      const { error, field, bound, value } = validation.data;
      return new ApiError("validation", error, { status, validation: { field, bound, value } });
    }
  }

  const generic = wireErrorBody.safeParse(payload);
  const message = generic.success ? generic.data.error : `request failed with status ${status}`;
  return new ApiError(errorKindForStatus(status), message, { status });
};

/** Perform the request and surface a non-2xx as a typed ApiError; returns the raw Response. */
async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  const { method = "GET", body } = init;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // Attach the OIDC access token when authenticated (2b); absent in the unauthenticated 2a posture.
  const token = getAccessToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(url(path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw new ApiError("network", "could not reach the platform API", { cause });
  }
  if (!response.ok) {
    // A 401 past the silent renew means the session is gone — bounce to login (frontend
    // architecture §9). No-op when auth is disabled.
    if (response.status === 401) handleUnauthorized();
    throw await parseError(response);
  }
  return response;
}

/** Request a JSON body and validate it through `schema`, returning the parsed view (output) type. */
async function requestJson<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  init: RequestInit = {},
): Promise<z.infer<S>> {
  const response = await rawFetch(path, init);

  let json: unknown;
  try {
    json = await response.json();
  } catch (cause) {
    throw new ApiError("parse", "response body was not valid JSON", { cause });
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError("parse", "response did not match the contract", { cause: parsed.error });
  }
  return parsed.data;
}

export const apiClient = {
  get: <S extends z.ZodTypeAny>(path: string, schema: S) => requestJson(path, schema),
  post: <S extends z.ZodTypeAny>(path: string, body: unknown, schema: S) =>
    requestJson(path, schema, { method: "POST", body }),
  put: <S extends z.ZodTypeAny>(path: string, body: unknown, schema: S) =>
    requestJson(path, schema, { method: "PUT", body }),
  patch: <S extends z.ZodTypeAny>(path: string, body: unknown, schema: S) =>
    requestJson(path, schema, { method: "PATCH", body }),
  delete: async (path: string): Promise<void> => {
    await rawFetch(path, { method: "DELETE" });
  },
};
