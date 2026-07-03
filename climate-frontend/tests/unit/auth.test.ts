import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { deriveRole, parseRoles } from "../../src/features/auth/roles";
import { apiClient } from "../../src/api/client";
import { setAccessToken } from "../../src/api/authToken";

/** Encode a payload object as an unsigned JWT (header.payload.signature) for role parsing. */
function fakeJwt(payload: unknown): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.sig`;
}

describe("parseRoles / deriveRole", () => {
  it("reads realm_access.roles and maps the operator role", () => {
    const token = fakeJwt({ realm_access: { roles: ["gh-operator", "offline_access"] } });
    expect(parseRoles(token)).toContain("gh-operator");
    expect(deriveRole(parseRoles(token))).toBe("operator");
  });

  it("falls back to viewer without the operator role", () => {
    const token = fakeJwt({ realm_access: { roles: ["gh-viewer"] } });
    expect(deriveRole(parseRoles(token))).toBe("viewer");
  });

  it("is defensive against missing / malformed tokens", () => {
    expect(parseRoles(null)).toEqual([]);
    expect(parseRoles("not-a-jwt")).toEqual([]);
    expect(deriveRole(parseRoles(undefined))).toBe("viewer");
  });
});

describe("apiClient auth header", () => {
  afterEach(() => {
    setAccessToken(null);
    vi.restoreAllMocks();
  });

  it("attaches the bearer token when authenticated and omits it otherwise", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const schema = z.object({ ok: z.boolean() });

    setAccessToken("token-123");
    await apiClient.get("/greenhouses", schema);
    let headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get("Authorization")).toBe("Bearer token-123");

    setAccessToken(null);
    await apiClient.get("/greenhouses", schema);
    headers = new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers);
    expect(headers.get("Authorization")).toBeNull();
  });
});
