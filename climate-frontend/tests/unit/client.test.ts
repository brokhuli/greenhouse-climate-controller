import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiClient, getHttpStatus } from "../../src/api/client";
import { wireGreenhouseDetail } from "../../src/api/schemas";
import { restFixture } from "../fixtures";

type FetchImpl = (input: string, init?: RequestInit) => Promise<unknown>;

const mockFetch = (impl: FetchImpl) => {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
};

const jsonResponse = (status: number, data: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

afterEach(() => vi.unstubAllGlobals());

describe("apiClient", () => {
  it("parses a 200 body through the schema", async () => {
    mockFetch(async () => jsonResponse(200, restFixture("greenhouse-detail.json")));
    const detail = await apiClient.get("/greenhouses/gh-a", wireGreenhouseDetail);
    expect(detail.id).toBe("gh-a");
  });

  it("maps 422 to a validation ApiError naming the field", async () => {
    mockFetch(async () =>
      jsonResponse(422, {
        error: "out of range",
        field: "humidity_high_pct",
        bound: "0..100",
        value: 150,
      }),
    );
    await expect(
      apiClient.patch("/greenhouses/gh-a/setpoints", {}, wireGreenhouseDetail),
    ).rejects.toMatchObject({ kind: "validation", validation: { field: "humidity_high_pct" } });
  });

  it("maps 404 / 503 / 5xx to typed kinds", async () => {
    const expectations = [
      [404, "not_found"],
      [503, "unavailable"],
      [500, "server"],
    ] as const;
    for (const [status, kind] of expectations) {
      mockFetch(async () => jsonResponse(status, { error: "nope" }));
      const error = await apiClient.get("/greenhouses/none", wireGreenhouseDetail).catch((e) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).kind).toBe(kind);
    }
  });

  it("maps a network failure to kind network", async () => {
    mockFetch(async () => {
      throw new Error("offline");
    });
    const error = await apiClient.get("/x", wireGreenhouseDetail).catch((e) => e);
    expect(error).toMatchObject({ kind: "network" });
  });

  it("maps a schema mismatch to kind parse", async () => {
    mockFetch(async () => jsonResponse(200, { id: "BAD UPPER", display_name: 5 }));
    const error = await apiClient.get("/x", wireGreenhouseDetail).catch((e) => e);
    expect(error).toMatchObject({ kind: "parse" });
  });

  it("exposes the HTTP status of an ApiError via getHttpStatus, undefined otherwise", () => {
    expect(getHttpStatus(new ApiError("server", "boom", { status: 500 }))).toBe(500);
    expect(getHttpStatus(new ApiError("network", "offline"))).toBeUndefined();
    expect(getHttpStatus(new Error("plain"))).toBeUndefined();
    expect(getHttpStatus(undefined)).toBeUndefined();
  });

  it("returns undefined for a 204 delete and uses the DELETE method", async () => {
    const fn = mockFetch(async () => ({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("no body");
      },
    }));
    await expect(apiClient.delete("/greenhouses/gh-a")).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledWith(
      expect.stringContaining("/api/greenhouses/gh-a"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
