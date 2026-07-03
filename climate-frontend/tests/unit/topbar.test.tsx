import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { TopBar } from "../../src/components/TopBar";
import { queryKeys } from "../../src/api/queries/keys";
import type { Assignment, CropProfile } from "../../src/api/schemas";
import { makeClient, renderWithProviders, sampleDetail, sampleSetpoints } from "../utils";

const profile = (): CropProfile => ({
  id: "lettuce",
  name: "Lettuce",
  crop: "lettuce",
  stages: [{ stage: "vegetative", targets: sampleSetpoints({ zones: [] }) }],
});

describe("TopBar", () => {
  it("adds the active crop profile to greenhouse detail titles", () => {
    const client = makeClient();
    const assignment: Assignment = {
      greenhouseId: "gh-a",
      profileId: "lettuce",
      stage: "vegetative",
    };
    client.setQueryData(queryKeys.greenhouse("gh-a"), sampleDetail({ id: "gh-a" }));
    client.setQueryData(queryKeys.assignment("gh-a"), assignment);
    client.setQueryData(queryKeys.profile("lettuce"), profile());

    renderWithProviders(<TopBar />, { client, route: "/greenhouses/gh-a" });

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(/Greenhouse A\s*•\s*Lettuce/);
    expect(heading).not.toHaveTextContent("vegetative");
  });
});
