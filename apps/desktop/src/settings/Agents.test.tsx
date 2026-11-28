// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import type { HarnessInfo, SettingsInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings.js";
import { settings } from "./testing.js";

afterEach(cleanup);

const agent = (id: string, label: string, models: string[] = []): HarnessInfo => ({
  ...{ id, label, installed: true, signedIn: true, defaultModel: null },
  models: models.map((m) => ({ id: m, label: m })),
});
const ALL = [
  agent("claude-code", "Claude Code", ["opus", "haiku"]),
  agent("codex", "Codex", ["sol"]),
  agent("grok-build", "Grok Build", ["big"]),
  agent("opencode", "opencode"),
];
const JUDGES: SettingsInfo["judges"] = {
  "grok-build": { model: "fast", checked: true, shipped: true, last: null, checking: false },
  codex: { model: "luna", checked: false, shipped: false, last: null, checking: false },
};

function client(more: Partial<SettingsInfo> = {}) {
  const now: SettingsInfo = {
    ...settings,
    agentOrder: ["opencode", "grok-build", "codex", "claude-code"],
    strongest: { agent: "claude-code", model: "opus", effort: "high" },
    quickNow: "claude-code:opus",
    judges: JUDGES,
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

const patched = (c: ReturnType<typeof client>, patch: object) =>
  expect(c.call).toHaveBeenCalledWith("settings.set", { patch });

// The user, 2026-11-24: two model settings and the rest automatic. Settings → Agents starts with "Ions think with"
// (Strongest, or your pick) and "Chats ions start run on" (Automatic, or your pick), each with its effort; then one
// line per agent with its status, usage, "Avoid unless I ask" and, when it isn't checked yet, "Check as judge"; under
// More, "Prefer in this order" (empty: Automatic decides). The judge, the limit choice and Pick by usage are gone.
describe("Settings → Agents", () => {
  it("picks what ions think with, from the strongest you have", async () => {
    const c = client({ quick: "" });
    render(<Settings client={c} onOpenIon={() => {}} />);
    expect(await screen.findByText("Strongest you have: Claude Code · opus · High")).toBeTruthy();
    const brain = within(screen.getByRole("radiogroup", { name: "Ions think with" }));
    await waitFor(() =>
      expect(brain.getByRole("radio", { name: "Strongest" }).getAttribute("aria-checked")).toBe("true"),
    );
    fireEvent.click(brain.getByRole("radio", { name: "Codex" }));
    patched(c, { quick: "codex" });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Ions' effort" })).getByRole("button", { name: "Low" }),
    );
    patched(c, { effort: "low" });
  });

  // Tour of PR #36, 2026-11-24: Fake was picked while the line said "Strongest you have", and the effort showed Default
  // while the line said High. The line names whichever is used, and the effort's Auto says what it means.
  it("says whose model ions think with, and what Auto effort means", async () => {
    const c = client({ quick: "grok-build", quickNow: "grok-build", effort: null });
    render(<Settings client={c} onOpenIon={() => {}} />);
    expect(await screen.findByText("Yours: Grok Build · Default · High")).toBeTruthy();
    expect(screen.queryByText(/^Strongest you have/)).toBeNull();
    const brain = within(screen.getByRole("radiogroup", { name: "Ions think with" }));
    expect(brain.getByRole("radio", { name: "Strongest" }).getAttribute("aria-checked")).toBe("false");
    const ions = within(screen.getByRole("group", { name: "Ions' effort" }));
    expect(ions.getByRole("button", { name: "Auto" }).className).toContain("on");
    expect(screen.getByText("High for you, Medium for routine")).toBeTruthy();
    const chats = within(screen.getByRole("group", { name: "Chats' effort" }));
    expect(chats.getByRole("button", { name: "Auto" }).className).toContain("on");
    expect(screen.getByText("The agent's own")).toBeTruthy();
  });

  it("picks what chats ions start run on, and goes back to Automatic", async () => {
    const c = client({ chats: "codex:sol", chatsEffort: "medium" });
    render(<Settings client={c} onOpenIon={() => {}} />);
    const chats = within(await screen.findByRole("radiogroup", { name: "Chats ions start run on" }));
    await waitFor(() =>
      expect(chats.getByRole("radio", { name: "Codex" }).getAttribute("aria-checked")).toBe("true"),
    );
    expect((screen.getByLabelText("Chats ions start run on model") as HTMLSelectElement).value).toBe("sol");
    fireEvent.click(chats.getByRole("radio", { name: "Automatic" }));
    patched(c, { chats: null });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Chats' effort" })).getByRole("button", { name: "High" }),
    );
    patched(c, { chatsEffort: "high" });
  });

  it("avoids an agent unless you ask, and checks one as judge", async () => {
    const c = client({ avoid: { opencode: true } });
    render(<Settings client={c} onOpenIon={() => {}} />);
    // Plan 21 Task 4: the switches and Check as judge wait under More.
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    const opencode = await screen.findByRole("switch", { name: "opencode: avoid unless I ask" });
    expect(opencode.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: "Codex: avoid unless I ask" }));
    patched(c, { avoid: { codex: true } });
    const codexRow = screen.getByRole("switch", { name: "Codex: avoid unless I ask" }).closest(".hrow")!;
    const check = within(codexRow as HTMLElement).getByRole("button", { name: "Check as judge" });
    expect(check.title).toMatch(/^The judge decides Auto's calls/);
    fireEvent.click(check);
    expect(c.call).toHaveBeenCalledWith("judge.check", { harness: "codex" });
    const grokRow = screen.getByRole("switch", { name: "Grok Build: avoid unless I ask" }).closest(".hrow")!;
    expect(grokRow.textContent).toContain("Checked as judge");
    // Plan 21 Task 3: "judge" is explained on hover, not in hint text.
    expect(within(grokRow as HTMLElement).getByText("Checked as judge").title).toMatch(
      /decides Auto's calls/,
    );
  });

  // PR #36 final review, 2026-11-24: a check that failed for want of answers said "allowed 0".
  it("says a failed check didn't answer enough, or what it allowed", async () => {
    const last = { agent: "codex", model: "luna", date: "2026-11-24", cases: 59, agreement: 40, unsure: 2 };
    const c = client({
      judges: {
        ...JUDGES,
        codex: { ...JUDGES.codex!, last: { ...last, pass: false, dangerous: [], failed: 12 } },
        opencode: { ...JUDGES.codex!, last: { ...last, pass: false, dangerous: ["a", "b"], failed: 0 } },
      },
    });
    render(<Settings client={c} onOpenIon={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    const row = async (name: string) =>
      (await screen.findByRole("switch", { name: `${name}: avoid unless I ask` })).closest(".hrow")!
        .textContent;
    expect(await row("Codex")).toContain("Not a judge: didn't answer enough");
    expect(await row("opencode")).toContain("Not a judge: allowed 2 dangerous");
    // Tour, 2026-11-24: a quiet text link, not a grey block; the toggles say what they are.
    expect(screen.getAllByRole("button", { name: "Check as judge" })[0]!.className).toBe("lnk");
    const codex = (await screen.findByRole("switch", { name: "Codex: avoid unless I ask" })).closest(
      ".hrow",
    )!;
    expect([...codex.querySelectorAll(".swl")].map((l) => l.getAttribute("title"))).toEqual([
      "Avoid unless I ask",
      "Use its own tools",
    ]);
  });

  // Plan 21 Task 4 tour (a fresh home, 2026-11-28): the agents took ~20 s to be checked and "Coding agents" stood over an
  // empty box with no sign anything was happening.
  it("says the agents are being checked while they are", async () => {
    const c = client();
    const answer = c.call.getMockImplementation()!;
    c.call.mockImplementation(((cmd: string) =>
      cmd === "harnesses.list" ? new Promise(() => {}) : answer(cmd)) as never);
    render(<Settings client={c} onOpenIon={() => {}} />);
    const row = await screen.findByText("Checking your agents");
    expect(row.closest(".srow")?.querySelector(".spin")).not.toBeNull();
  });

  // Plan 21, 2026-11-28: ion's own check of a free agent stops at its first limit and says so.
  it("says when a free agent's use ran out during its check", async () => {
    const c = client({
      judges: {
        ...JUDGES,
        opencode: {
          model: "free",
          checked: false,
          shipped: false,
          last: null,
          checking: false,
          ranOut: true,
        },
        codex: { ...JUDGES.codex!, checking: true },
      },
    });
    render(<Settings client={c} onOpenIon={() => {}} />);
    // Plan 21 Task 4: each agent's switches wait under More.
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    const row = async (name: string) =>
      (await screen.findByRole("switch", { name: `${name}: avoid unless I ask` })).closest(".hrow")!
        .textContent;
    expect(await row("opencode")).toContain("Its free use ran out during the check");
    expect(await row("Codex")).toContain("Checking as judge…");
  });

  it("keeps an optional order under More, with a way back to Automatic", async () => {
    const c = client({ prefer: ["codex"] });
    render(<Settings client={c} onOpenIon={() => {}} />);
    expect(screen.queryByText("Prefer in this order")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect(screen.getByText("Prefer in this order")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "Move Codex" }), { key: "ArrowUp" });
    patched(c, { agentOrder: ["opencode", "codex", "grok-build", "claude-code"] });
    fireEvent.click(screen.getByRole("button", { name: "Automatic" }));
    patched(c, { agentOrder: [] });
  });

  // PR #36 final review, 2026-11-24: a judge or Dream agent kept from an older config isn't hidden: one quiet line
  // each, with a way back to automatic.
  it("shows a judge or Dream agent you set before, with a way back to automatic", async () => {
    const c = client({
      judge: "codex:luna",
      judgeChecked: false,
      dream: { mode: "nightly", agent: "opencode" },
    });
    render(<Settings client={c} onOpenIon={() => {}} />);
    expect(await screen.findByText("Judge: yours, Codex · luna · not checked")).toBeTruthy();
    expect(screen.getByText("Dream: yours, opencode")).toBeTruthy();
    const back = screen.getAllByRole("button", { name: "Back to automatic" });
    fireEvent.click(back[0]!);
    patched(c, { judge: null });
    fireEvent.click(back[1]!);
    patched(c, { dream: { agent: null } });
  });

  it("has no judge row, limit choice or Pick by usage", async () => {
    render(<Settings client={client()} onOpenIon={() => {}} />);
    await screen.findByRole("radiogroup", { name: "Ions think with" });
    expect(screen.queryByRole("radiogroup", { name: "Judge" })).toBeNull();
    expect(screen.queryByText("When an agent hits its limit")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Pick by usage" })).toBeNull();
  });
});
