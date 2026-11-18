// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Resizer } from "./Resizer.js";

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--side-w");
});

const width = () => document.documentElement.style.getPropertyValue("--side-w");

// The user, 2026-11-18: the sidebar and the side panel can be made wider or narrower.
describe("Resizer", () => {
  it("drags its edge to a new width, within its limits", () => {
    render(<Resizer name="--side-w" label="Sidebar width" initial={256} min={200} max={420} edge="right" />);
    const handle = screen.getByRole("separator", { name: "Sidebar width" });
    fireEvent.mouseDown(handle, { clientX: 256 });
    fireEvent.mouseMove(document, { clientX: 320 });
    fireEvent.mouseUp(document);
    expect(width()).toBe("320px");
    fireEvent.mouseDown(handle, { clientX: 320 });
    fireEvent.mouseMove(document, { clientX: 900 });
    fireEvent.mouseUp(document);
    expect(width()).toBe("420px");
  });

  it("grows the other way for a panel on the right, and moves with the arrow keys", () => {
    render(<Resizer name="--side-w" label="Panel width" initial={400} min={300} max={720} edge="left" />);
    const handle = screen.getByRole("separator", { name: "Panel width" });
    fireEvent.mouseDown(handle, { clientX: 1000 });
    fireEvent.mouseMove(document, { clientX: 900 });
    fireEvent.mouseUp(document);
    expect(width()).toBe("500px");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(width()).toBe("516px");
  });
});
