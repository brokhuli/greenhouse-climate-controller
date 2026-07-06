import { useReducer } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Dialog } from "../../src/components/ui/Dialog";

/**
 * Regression: the fleet view is patched live and re-renders constantly, passing a fresh `onClose`
 * arrow to the dialog each time. The focus-management effect must key only on `open` — if it also
 * keys on `onClose`, it re-runs on every parent render and yanks focus out of the field mid-type.
 */
describe("Dialog", () => {
  function Harness() {
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    return (
      <>
        <button onClick={rerender}>rerender parent</button>
        {/* New onClose identity on every render, exactly like the real callers. */}
        <Dialog open onClose={() => {}} title="Register greenhouse">
          <input aria-label="ID (slug)" />
        </Dialog>
      </>
    );
  }

  it("keeps focus in a field when the parent re-renders with a new onClose", () => {
    render(<Harness />);
    const input = screen.getByLabelText("ID (slug)") as HTMLInputElement;

    input.focus();
    fireEvent.change(input, { target: { value: "g" } });
    expect(document.activeElement).toBe(input);

    // A live-patch tick re-renders the parent, handing the dialog a fresh onClose.
    fireEvent.click(screen.getByText("rerender parent"));

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("g");
  });
});
