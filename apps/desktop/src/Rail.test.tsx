// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Rail } from "./Rail.js";

afterEach(cleanup);

// The lab's rail: Chats, then Ions as its transparent orbit glyph with a dot when something needs you.
describe("Rail", () => {
  it("draws Ions as the lab's glyph, with the needs dot only when something waits", () => {
    const setMode = vi.fn();
    const { container, rerender } = render(<Rail mode="chats" setMode={setMode} initial="Y" needs={2} />);
    const ions = screen.getByRole("button", { name: "Ions" });
    expect(ions.querySelector("canvas")).not.toBeNull();
    expect(ions.querySelector("svg")).toBeNull();
    expect((ions.querySelector(".dotb") as HTMLElement).hidden).toBe(false);
    fireEvent.click(ions);
    expect(setMode).toHaveBeenCalledWith("ions");
    rerender(<Rail mode="ions" setMode={setMode} initial="Y" needs={0} />);
    expect((container.querySelector(".dotb") as HTMLElement).hidden).toBe(true);
    expect(ions.classList.contains("on")).toBe(true);
  });
  // The lab's rail: Settings sits above you, at the bottom.
  it("opens Settings from the gear", () => {
    const setMode = vi.fn();
    render(<Rail mode="chats" setMode={setMode} initial="Y" needs={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(setMode).toHaveBeenCalledWith("settings");
  });
  // Plan 21 Task 4: the lab's Search sits under Ions, so a page tucked under More is one click away.
  it("opens Search from the rail", () => {
    const onSearch = vi.fn();
    render(<Rail mode="chats" setMode={() => {}} initial="Y" needs={0} onSearch={onSearch} />);
    const search = screen.getByRole("button", { name: "Search" });
    expect(search.title).toBe("Search  ⌘K");
    fireEvent.click(search);
    expect(onSearch).toHaveBeenCalled();
  });
});
