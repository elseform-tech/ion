// @vitest-environment jsdom
import { ApiCallError } from "@ion/client/browser";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(c.call).toHaveBeenLastCalledWith("settings.set", { patch: { maxRuns: 2 } });
    for (const gone of [/folder/i, /debug/i, /runs/i, /max/i]) expect(screen.queryByText(gone)).toBeNull();
  });

  let lastClient: ReturnType<typeof settingsClient> | null = null;
  const general = async (maxRuns: number | "auto") => {
    cleanup();
    const c = settingsClient({ now: { ...settings, maxRuns, autoRuns: 4 } });
    lastClient = c;
    render(<Settings client={c} onOpenIon={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    await screen.findByLabelText("Chats at once");
    const step = (name: "Less" | "More") => fireEvent.click(screen.getByRole("button", { name }));
    const button = (name: "Less" | "More") => screen.getByRole("button", { name }) as HTMLButtonElement;
    const saved = (maxRuns: number | "auto") =>
      expect(c.call).toHaveBeenLastCalledWith("settings.set", { patch: { maxRuns } });
    return { step, button, saved };
  };

  // Tour, 2026-11-20: More from Auto went to 1, fewer than Auto's own (half the cores); quick clicks lost steps.
  it("steps from the number Auto means, through Auto, and keeps quick clicks", async () => {
    let g = await general("auto");
    expect(screen.getByLabelText("Chats at once").textContent).toBe("Auto");
    g.step("More");
    g.saved(5);
    expect(screen.getByLabelText("Chats at once").textContent).toBe("5"); // before the daemon answers
    g.step("More");
    g.saved(6);
    g = await general("auto");
    g.step("Less");
    g.saved(3);
    g = await general(3);
    g.step("More");
    g.saved("auto");
    g = await general(1);
    expect(g.button("Less").disabled).toBe(true);
    g = await general(32);
    expect(g.button("More").disabled).toBe(true);
  });

  // Task review, 2026-11-20 (round 2): an error left from an earlier refusal dropped the next pick at once.
  it("holds a new pick even while an earlier refusal still shows", async () => {
    const g = await general("auto");
    const c = vi.mocked(lastClient!.call);
    c.mockRejectedValueOnce(new ApiCallError("invalid", "Between 1 and 32 chats"));
    g.step("More");
    expect(await screen.findByText("Between 1 and 32 chats")).toBeTruthy();
    expect(screen.getByLabelText("Chats at once").textContent).toBe("Auto");
    c.mockImplementationOnce(() => new Promise(() => {})); // the daemon hasn't answered yet
    g.step("More");
    await act(async () => {});
    expect(screen.getByLabelText("Chats at once").textContent).toBe("5");
  });

  it("shows the daemon's reason when it refuses", async () => {
    const c = settingsClient({ refuse: "Between 1 and 32 chats" });
    render(<Settings client={c} onOpenIon={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect(await screen.findByText("Between 1 and 32 chats")).toBeTruthy();
  });
});
