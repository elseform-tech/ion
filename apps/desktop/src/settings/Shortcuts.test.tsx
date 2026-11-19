// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HOTKEYS, hit } from "../hotkeys.js";
import { Settings } from "./Settings.js";
import { settingsClient } from "./testing.js";

afterEach(cleanup);

const press = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...mods,
});

// The user, 2026-11-19: "also build the settings as well… general… notifications, shortcuts…". The page and the
// handlers read one table (hotkeys.ts), so the page lists exactly what the app does.
describe("Settings → Shortcuts", () => {
  it("lists every hotkey the app handles", async () => {
    render(<Settings client={settingsClient()} onOpenIon={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Shortcuts" }));
    const names = [
      "Hide sidebar",
      "Next effort",
      "Send",
      "Queue while it works",
      "Send now",
      "New line",
      "Stop",
    ];
    expect(HOTKEYS.map((k) => k.name)).toEqual(names);
    for (const k of HOTKEYS) {
      const row = (await screen.findByText(k.name)).closest(".srow");
      expect([...(row?.querySelectorAll("kbd") ?? [])].map((b) => b.textContent)).toEqual(k.keys);
    }
  });

  it("matches the keys the handlers act on", () => {
    expect(hit("sidebar", press("b", { metaKey: true }))).toBe(true);
    expect(hit("sidebar", press("B", { ctrlKey: true }))).toBe(true);
    expect(hit("sidebar", press("b"))).toBe(false);
    expect(hit("effort", press(".", { metaKey: true }))).toBe(true);
    expect(hit("send", press("Enter"))).toBe(true);
    expect(hit("send", press("Enter", { shiftKey: true }))).toBe(false);
    expect(hit("now", press("Enter", { metaKey: true }))).toBe(true);
    expect(hit("now", press("Enter"))).toBe(false);
    expect(hit("newline", press("Enter", { shiftKey: true }))).toBe(true);
    expect(hit("stop", press("Escape"))).toBe(true);
  });
});
