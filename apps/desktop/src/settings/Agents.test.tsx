// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import type { HarnessInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings.js";
import { settings } from "./testing.js";

afterEach(cleanup);

const agent = (id: string, label: string): HarnessInfo => ({
  ...{ id, label, installed: true, signedIn: true, models: [], defaultModel: null },
});
const ALL = [
  agent("claude-code", "Claude Code"),
  agent("codex", "Codex"),
  agent("grok-build", "Grok Build"),
  agent("opencode", "opencode"),
];

function client(more: Partial<typeof settings> = {}) {
  const now = {
    ...settings,
    agentOrder: ["opencode", "grok-build", "codex", "claude-code"],
    onLimit: "ask" as const,
    byUsage: false,
    ...more,
  };
  const call = vi.fn(async (cmd: string) => {
    if (cmd === "harnesses.list") return ALL;
    if (cmd === "settings.get" || cmd === "settings.set") return now;
    if (cmd === "projects.list" || cmd === "ions.list" || cmd === "usage.list") return [];
    return { ok: true };
  });
  return { call, subscribe: vi.fn(async () => () => {}) } as unknown as IonClient & { call: typeof call };
}

const names = () =>
  [...document.querySelectorAll(".hrow")].map((r) => r.querySelector("div")?.firstChild?.textContent);

// The user, 2026-11-22: Settings → Agents holds the agent order (a drag list), what ion does when an agent hits its
// limit, and Pick by usage (off at first).
describe("Settings → Agents: picking agents", () => {
  it("lists the agents in your order and saves a new one when you drag", async () => {
    const c = client();
    render(<Settings client={c} onOpenIon={() => {}} />);
    await waitFor(() => expect(names()).toEqual(["opencode", "Grok Build", "Codex", "Claude Code"]));
    const rows = document.querySelectorAll(".hrow");
    fireEvent.dragStart(rows[2]!.querySelector(".grip")!);
    fireEvent.dragOver(rows[0]!);
    fireEvent.drop(rows[0]!);
    expect(c.call).toHaveBeenCalledWith("settings.set", {
      patch: { agentOrder: ["codex", "opencode", "grok-build", "claude-code"] },
    });
  });

  it("moves an agent with the keyboard too", async () => {
    const c = client();
    render(<Settings client={c} onOpenIon={() => {}} />);
    const grip = await screen.findByRole("button", { name: "Move Codex" });
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(c.call).toHaveBeenCalledWith("settings.set", {
      patch: { agentOrder: ["opencode", "codex", "grok-build", "claude-code"] },
    });
  });

  it("asks at a limit by default, and saves another choice", async () => {
    const c = client();
    render(<Settings client={c} onOpenIon={() => {}} />);
    expect(await screen.findByText("When an agent hits its limit")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask" }).className).toBe("on");
    fireEvent.click(screen.getByRole("button", { name: "Continue on the next agent" }));
    expect(c.call).toHaveBeenCalledWith("settings.set", { patch: { onLimit: "continue" } });
  });

  it("has Pick by usage off at first", async () => {
    const c = client();
    render(<Settings client={c} onOpenIon={() => {}} />);
    const sw = await screen.findByRole("switch", { name: "Pick by usage" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(c.call).toHaveBeenCalledWith("settings.set", { patch: { byUsage: true } });
  });
});
