import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import SetpointsView from "../../src/features/greenhouse/SetpointsView";
import { queryKeys } from "../../src/api/queries/keys";
import { makeClient, renderWithProviders, sampleDetail } from "../utils";

const renderAt = (id: string, client = makeClient()) =>
  renderWithProviders(
    <Routes>
      <Route path="/greenhouses/:id/setpoints" element={<SetpointsView />} />
    </Routes>,
    { client, route: `/greenhouses/${id}/setpoints` },
  );

describe("SetpointsView", () => {
  it("renders the setpoint editor for the routed greenhouse with a back link to its detail", () => {
    const client = makeClient();
    client.setQueryData(
      queryKeys.greenhouse("gh-a"),
      sampleDetail({ id: "gh-a", displayName: "Greenhouse A" }),
    );
    renderAt("gh-a", client);

    expect(screen.getByRole("heading", { name: "Setpoints" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to greenhouse a/i })).toHaveAttribute(
      "href",
      "/greenhouses/gh-a",
    );
  });

  it("disables editing when the routed greenhouse is offline", () => {
    const client = makeClient();
    client.setQueryData(
      queryKeys.greenhouse("gh-a"),
      sampleDetail({ id: "gh-a", status: "offline" }),
    );
    renderAt("gh-a", client);

    expect(screen.getByText(/controller offline/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review & apply/i })).toBeDisabled();
  });
});
