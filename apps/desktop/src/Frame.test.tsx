// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Frame, useSidebar } from "./Frame.js";

afterEach(cleanup);

function Window() {
  const [open, toggle] = useSidebar();
  return (
    <div className={open ? "win" : "win side-off"} data-testid="win">
      <Frame sidebar={open} onSidebar={toggle} />
    </div>
  );
}

// The user, 2026-11-19: the left sidebar can be hidden and shown again, from a frame along the window's top.
describe("the frame", () => {
  it("hides and shows the sidebar, by its button or ⌘B", () => {
    render(<Window />);
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(screen.getByTestId("win").className).toContain("side-off");
    fireEvent.keyDown(document, { key: "b", metaKey: true });
    expect(screen.getByTestId("win").className).not.toContain("side-off");
    fireEvent.keyDown(document, { key: "b", metaKey: true });
    expect(screen.getByRole("button", { name: "Show sidebar" })).toBeTruthy();
  });
});
