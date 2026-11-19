// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Settings } from "./Settings.js";
import { settings, settingsClient } from "./testing.js";

afterEach(cleanup);

// The user, 2026-11-19: "also build the settings as well… general… notifications, shortcuts…". General holds the
// default access and how many chats run at once ("use chat instead of runs, use easier to understand language");
// the projects folder is fixed and debug mode is for people working on ion: neither is here.
describe("Settings → General", () => {
  it("shows and saves access and chats at once", async () => {
    const c = settingsClient({ now: { ...settings, maxRuns: 2 } });
    render(<Settings client={c} onOpenIon={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    const access = await screen.findByRole("group", { name: "Default access" });
    expect(within(access).getByRole("button", { name: "Auto" }).className).toContain("on");
    fireEvent.click(within(access).getByRole("button", { name: "Full access" }));
    expect(c.call).toHaveBeenCalledWith("settings.set", { patch: { access: "full" } });
    expect(await screen.findByText("Chats at once")).toBeTruthy();
    expect(screen.getByLabelText("Chats at once").textContent).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(c.call).toHaveBeenCalledWith("settings.set", { patch: { maxRuns: 3 } });
    fireEvent.click(screen.getByRole("button", { name: "Less" }));
    expect(c.call).toHaveBeenCalledWith("settings.set", { patch: { maxRuns: 1 } });
    for (const gone of [/folder/i, /debug/i, /runs/i, /max/i]) expect(screen.queryByText(gone)).toBeNull();
  });

  it("goes from Auto to one chat and back, and never past 32", async () => {
    const c = settingsClient();
    render(<Settings client={c} onOpenIon={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect((await screen.findByLabelText("Chats at once")).textContent).toBe("Auto");
    expect((screen.getByRole("button", { name: "Less" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(c.call).toHaveBeenCalledWith("settings.set", { patch: { maxRuns: 1 } });
    cleanup();
    const one = settingsClient({ now: { ...settings, maxRuns: 1 } });
    render(<Settings client={one} onOpenIon={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    await screen.findByText("1");
    fireEvent.click(screen.getByRole("button", { name: "Less" }));
    expect(one.call).toHaveBeenCalledWith("settings.set", { patch: { maxRuns: "auto" } });
    cleanup();
    const most = settingsClient({ now: { ...settings, maxRuns: 32 } });
    render(<Settings client={most} onOpenIon={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    await screen.findByText("32");
    expect((screen.getByRole("button", { name: "More" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the daemon's reason when it refuses", async () => {
    const c = settingsClient({ refuse: "Between 1 and 32 chats" });
    render(<Settings client={c} onOpenIon={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect(await screen.findByText("Between 1 and 32 chats")).toBeTruthy();
  });
});
