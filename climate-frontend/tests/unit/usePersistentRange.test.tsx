import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { usePersistentRange } from "../../src/hooks/usePersistentRange";

const wrapper =
  (initialEntry: string) =>
  ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
  );

/** Drive the hook alongside a search-params reader so assertions can see both sources of truth. */
function renderRange(initialEntry: string) {
  return renderHook(
    () => {
      const [searchParams] = useSearchParams();
      const [value, setValue] = usePersistentRange("range", "test:range");
      return { value, setValue, param: searchParams.get("range") };
    },
    { wrapper: wrapper(initialEntry) },
  );
}

afterEach(() => localStorage.clear());

describe("usePersistentRange", () => {
  it("prefers a valid URL param (deep links keep working)", () => {
    localStorage.setItem("test:range", "24h");
    const { result } = renderRange("/?range=6h");
    expect(result.current.value).toBe("6h");
  });

  it("falls back to the persisted value when the param is absent (the remount fix)", () => {
    localStorage.setItem("test:range", "24h");
    const { result } = renderRange("/");
    expect(result.current.value).toBe("24h");
  });

  it("defaults to 1h when neither the param nor a valid stored value exists", () => {
    localStorage.setItem("test:range", "nonsense");
    const { result } = renderRange("/");
    expect(result.current.value).toBe("1h");
  });

  it("ignores an invalid URL param and falls through to storage", () => {
    localStorage.setItem("test:range", "30m");
    const { result } = renderRange("/?range=bogus");
    expect(result.current.value).toBe("30m");
  });

  it("writes the new pick to both the URL param and localStorage", () => {
    const { result } = renderRange("/");
    act(() => result.current.setValue("6h"));
    expect(result.current.value).toBe("6h");
    expect(result.current.param).toBe("6h");
    expect(localStorage.getItem("test:range")).toBe("6h");
  });
});
