import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UserMenu } from "../../src/features/auth/UserMenu";
import { RoleContext, type AuthState } from "../../src/hooks/useRole";
import { renderWithProviders } from "../utils";

function authState(signOut = vi.fn()): AuthState {
  return {
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    role: "operator",
    isOperator: true,
    username: "operator",
    signIn: vi.fn(),
    signOut,
  };
}

describe("UserMenu", () => {
  it("opens a menu before signing out", async () => {
    const user = userEvent.setup();
    const signOut = vi.fn();

    renderWithProviders(
      <RoleContext.Provider value={authState(signOut)}>
        <UserMenu />
      </RoleContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: /open user menu/i }));

    expect(signOut).not.toHaveBeenCalled();
    await user.click(screen.getByRole("menuitem", { name: /sign out/i }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
