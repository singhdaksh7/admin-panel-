import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal, TextField } from "../src/components/ui";

function Host({ onEscape }: { onEscape?: () => void }) {
  const [text, setText] = useState("");
  // a NEW onClose closure on every render - this used to re-run the focus effect and swallow typing
  return (
    <Modal title="Edit" onClose={() => onEscape?.()}>
      <TextField label="Note" value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  );
}

afterEach(cleanup);

describe("Modal", () => {
  it("focuses the first form field (not the close button) and keeps focus while the parent re-renders", async () => {
    render(<Host />);
    const field = screen.getByLabelText("Note");
    expect(field).toHaveFocus();
    const u = userEvent.setup();
    await u.type(field, "hello world");
    expect(field).toHaveValue("hello world");
    expect(field).toHaveFocus();
  });

  it("closes on Escape using the latest onClose", async () => {
    const spy = vi.fn();
    render(<Host onEscape={spy} />);
    await userEvent.setup().keyboard("{Escape}");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("traps Tab inside the dialog", async () => {
    render(<Host />);
    const u = userEvent.setup();
    const dialog = screen.getByRole("dialog");
    for (let i = 0; i < 6; i++) {
      await u.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});
