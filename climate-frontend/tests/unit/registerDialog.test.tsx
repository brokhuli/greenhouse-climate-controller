import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { RegisterGreenhouseDialog } from "../../src/features/fleet/RegisterGreenhouseDialog";
import { makeClient, renderWithProviders } from "../utils";

const submitForm = () => {
  const form = document.getElementById("register-greenhouse-form") as HTMLFormElement;
  fireEvent.submit(form);
};

describe("RegisterGreenhouseDialog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("blocks submit and shows inline validation errors", async () => {
    renderWithProviders(<RegisterGreenhouseDialog open onClose={() => {}} />);
    submitForm();
    expect(await screen.findByText(/lowercase kebab slug/i)).toBeInTheDocument();
  });

  it("maps a 422 onto the named field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "id already registered",
              field: "id",
              bound: "unique",
              value: "gh-a",
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    renderWithProviders(<RegisterGreenhouseDialog open onClose={() => {}} />, {
      client: makeClient(),
    });

    fireEvent.change(screen.getByLabelText("ID (slug)"), { target: { value: "gh-a" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Greenhouse A" } });
    fireEvent.change(screen.getByLabelText("Controller REST URL"), {
      target: { value: "http://gh-a:8080" },
    });
    fireEvent.change(screen.getByLabelText("Controller MQTT topic root"), {
      target: { value: "gh/gh-a" },
    });
    submitForm();

    expect(await screen.findByText("id already registered")).toBeInTheDocument();
  });
});
