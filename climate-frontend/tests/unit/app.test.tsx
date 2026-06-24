import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../src/app/App";
import { Providers } from "../../src/app/providers";

const renderApp = () =>
  render(
    <Providers>
      <App />
    </Providers>,
  );

describe("App shell", () => {
  it("renders the console chrome and the lazy fleet landing view", async () => {
    renderApp();
    expect(screen.getByText("Greenhouse Site")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(await screen.findByText("Fleet overview")).toBeInTheDocument();
  });

  it("toggles the theme via the topbar control", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: /switch to light theme/i }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    await user.click(screen.getByRole("button", { name: /switch to dark theme/i }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
