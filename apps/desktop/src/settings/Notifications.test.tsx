// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { settingsClient } from "./testing.js";
import { Settings } from "./Settings.js";

afterEach(cleanup);

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
    fireEvent.change(screen.getByLabelText("Briefing time"), { target: { value: "07:15" } });
    set({ notifications: { briefing: { at: "07:15" } } });
    fireEvent.click(screen.getByRole("switch", { name: "Daily briefing" }));
    set({ notifications: { briefing: { on: false } } });
    fireEvent.change(screen.getByLabelText("Quiet from"), { target: { value: "23:00" } });
    set({ notifications: { quiet: { from: "23:00" } } });
    fireEvent.change(screen.getByLabelText("Quiet until"), { target: { value: "07:00" } });
    set({ notifications: { quiet: { to: "07:00" } } });
    fireEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
    set({ notifications: { quiet: { on: false } } });
    const shop = screen.getByRole("group", { name: "Shop" });
    expect(within(shop).getByRole("button", { name: "Needs me" }).className).toContain("on");
    fireEvent.click(within(shop).getByRole("button", { name: "Muted" }));
    set({ notifications: { projects: { shop: "muted" } } });
  });

  it("shows the daemon's reason for a time it refuses", async () => {
    const c = settingsClient({ refuse: "Use a time like 08:30" });
    await open(c);
    fireEvent.change(screen.getByLabelText("Briefing time"), { target: { value: "07:15" } });
    expect(await screen.findByText("Use a time like 08:30")).toBeTruthy();
  });
});
