import { describe, expect, it } from "vitest";
import { connectionStateFromWs } from "../../src/components/connection";

describe("connectionStateFromWs", () => {
  it("maps the StreamClient state onto the operator-facing indicator state", () => {
    expect(connectionStateFromWs("open")).toBe("live");
    expect(connectionStateFromWs("connecting")).toBe("reconnecting");
    expect(connectionStateFromWs("reconnecting")).toBe("reconnecting");
    expect(connectionStateFromWs("closed")).toBe("offline");
  });
});
