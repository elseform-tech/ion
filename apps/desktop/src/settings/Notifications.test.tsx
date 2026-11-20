// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { settingsClient } from "./testing.js";
import { Settings } from "./Settings.js";

afterEach(cleanup);

/** Types a time into a box and leaves it. */
const type = (label: string, value: string) => {
  const box = screen.getByLabelText(label);
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value } });
  fireEvent.blur(box);
};

const open = async (c: ReturnType<typeof settingsClient>) => {
  render(<Settings client={c} onOpenIon={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  await screen.findByText("How loud");
};

// The user, 2026-11-19: "also build the settings as well… general… notifications, shortcuts…". The lab's
// renderNotif: how loud each kind is (shown, not edited), the briefing and quiet hours, and each project's level.
describe("Settings → Notifications", () => {
  it("shows how loud, timing and each project's level, and saves them", async () => {
    const c = settingsClient();
    await open(c);
    for (const [kind, what] of [
      ["Urgent", "Notify and pin"],
      ["Needs you", "Pin"],
      ["Updates", "Briefing"],
    ] as const)
      expect(screen.getByText(kind).closest(".srow")?.textContent).toContain(what);
    const set = (patch: object) => expect(c.call).toHaveBeenCalledWith("settings.set", { patch });
    type("Briefing time", "07:15");
    set({ notifications: { briefing: { at: "07:15" } } });
    fireEvent.click(screen.getByRole("switch", { name: "Daily briefing" }));
    set({ notifications: { briefing: { on: false } } });
    type("Quiet from", "23:00");
    set({ notifications: { quiet: { from: "23:00" } } });
    type("Quiet until", "07:00");
    set({ notifications: { quiet: { to: "07:00" } } });
    fireEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
    set({ notifications: { quiet: { on: false } } });
    const shop = screen.getByRole("group", { name: "Shop" });
    expect(within(shop).getByRole("button", { name: "Needs me" }).className).toContain("on");
    fireEvent.click(within(shop).getByRole("button", { name: "Muted" }));
    set({ notifications: { projects: { shop: "muted" } } });
  });

  // Task review, 2026-11-20: the time boxes saved on every keystroke and were reset while you typed.
  it("saves a time once, when you leave the box or press Enter, and only if it changed", async () => {
    const c = settingsClient();
    await open(c);
    const box = screen.getByLabelText("Briefing time") as HTMLInputElement;
    const saves = () => c.call.mock.calls.filter(([cmd]) => cmd === "settings.set");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "09:30" } });
    fireEvent.change(box, { target: { value: "09:45" } });
    expect(saves()).toHaveLength(0);
    expect(box.value).toBe("09:45");
    fireEvent.blur(box);
    expect(saves()).toEqual([["settings.set", { patch: { notifications: { briefing: { at: "09:45" } } } }]]);
    const until = screen.getByLabelText("Quiet until") as HTMLInputElement;
    fireEvent.focus(until);
    fireEvent.blur(until);
    expect(saves()).toHaveLength(1); // unchanged: nothing to save
    fireEvent.focus(until);
    fireEvent.change(until, { target: { value: "06:30" } });
    fireEvent.keyDown(until, { key: "Enter" });
    expect(saves()).toHaveLength(2);
    expect(c.call).toHaveBeenLastCalledWith("settings.set", {
      patch: { notifications: { quiet: { to: "06:30" } } },
    });
  });

  it("shows the daemon's reason for a time it refuses", async () => {
    const c = settingsClient({ refuse: "Use a time like 08:30" });
    await open(c);
    type("Briefing time", "07:15");
    expect(await screen.findByText("Use a time like 08:30")).toBeTruthy();
  });
});
