import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig, type UserConfig } from "@ion/config";
import type { AgentCheckItem, Billing, HarnessInfo } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { AgentChecks, type AgentChecksDeps } from "./agent-checks.js";

// Plan 21 Task 5 (the user, 2026-11-28): ion checks its agents each night and tells you if one broke. Off until you
// turn it on; a small check per signed-in agent (free ones; one that isn't free only if you pick it, Claude Code
// too), never on an agent you avoid or one that's limited, never in the working day (quiet hours, else 01:00–06:00),
// and a failure is one "needs you" note, only the first time.

const info = (id: string, more: Partial<HarnessInfo> = {}): HarnessInfo => ({
  id,
  label: id === "grok-build" ? "Grok Build" : id,
  installed: true,
  signedIn: true,
  models: [],
  defaultModel: null,
  ...more,
});

const OK: AgentCheckItem[] = [
  { name: "Starts", ok: true },
  { name: "Answers", ok: true },
];
const BROKEN: AgentCheckItem[] = [
  { name: "Starts", ok: true },
  { name: "Answers", ok: false, note: "said nothing" },
  { name: "ion's tools", ok: false },
];

/** A local time on a fixed day (quiet hours are 22:00–08:00 by default). */
const at = (day: number, clock: string) => {
  const [h, m] = clock.split(":").map(Number) as [number, number];
  return new Date(2026, 10, day, h, m);
};

function setup(o: {
  config?: (c: UserConfig) => UserConfig;
  agents?: HarnessInfo[];
  billing?: Record<string, Billing>;
  limited?: string[];
  result?: (agent: string) => AgentCheckItem[];
  working?: () => boolean;
}) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "ion-agent-checks-")));
  const configFile = join(dataDir, "config.toml");
  saveUserConfig(configFile, (o.config ?? ((c) => c))(structuredClone(DEFAULT_CONFIG)));
  const smoked: string[] = [];
  const notes: string[] = [];
  const clock = { now: at(23, "02:00") };
  const deps: AgentChecksDeps = {
    dataDir,
    configFile,
    agents: async () => o.agents ?? [info("opencode")],
    limited: (id) => (o.limited ?? []).includes(id),
    billing: async (id) => o.billing?.[id] ?? "free",
    model: () => null,
    smoke: async (agent) => {
      smoked.push(agent);
      return (o.result ?? (() => OK))(agent);
    },
    notify: (body) => notes.push(body),
    working: o.working ?? (() => false),
    now: () => clock.now,
  };
  return { checks: new AgentChecks(deps), smoked, notes, clock, configFile };
}

const nightly = (c: UserConfig): UserConfig => ({ ...c, checks: { ...c.checks, nightly: true } });

describe("ion's nightly check of its agents", () => {
  it("off by default", async () => {
    const { checks, smoked } = setup({});
    await checks.tick();
    expect(smoked).toEqual([]);
    expect((await checks.info()).nightly).toBe(false);
  });

  it("checks each signed-in free agent once a night, in quiet hours", async () => {
    const { checks, smoked, clock } = setup({ config: nightly });
    await checks.tick();
    await checks.tick();
    expect(smoked).toEqual(["opencode"]);
    clock.now = at(24, "03:00");
    await checks.tick();
    expect(smoked).toEqual(["opencode", "opencode"]);
    expect((await checks.info()).last[0]).toMatchObject({ agent: "opencode", checks: OK });
  });

  it("never runs in the working day", async () => {
    const { checks, smoked, clock } = setup({ config: nightly });
    clock.now = at(23, "14:00");
    await checks.tick();
    // Quiet hours off: 01:00–06:00 only.
    const off = setup({
      config: (c) =>
        nightly({
          ...c,
          notifications: { ...c.notifications, quiet: { ...c.notifications.quiet, on: false } },
        }),
    });
    off.clock.now = at(23, "23:00");
    await off.checks.tick();
    expect([...smoked, ...off.smoked]).toEqual([]);
    off.clock.now = at(24, "01:30");
    await off.checks.tick();
    expect(off.smoked).toEqual(["opencode"]);
  });

  it("the routine skips a limited agent", async () => {
    const { checks, smoked } = setup({
      config: nightly,
      agents: [info("opencode"), info("other")],
      limited: ["opencode"],
    });
    await checks.tick();
    expect(smoked).toEqual(["other"]);
    const row = (await checks.info()).agents.find((a) => a.agent === "opencode");
    expect(row).toMatchObject({ included: false, why: "Limited" });
  });

  it("it never runs on an avoided or limited agent, not even when you check now or picked it", async () => {
    const { checks, smoked } = setup({
      config: (c) =>
        nightly({
          ...c,
          agents: { "grok-build": { avoid: true } },
          checks: { nightly: true, agents: ["grok-build", "opencode"] },
        }),
      agents: [info("opencode"), info("grok-build"), info("other")],
      limited: ["opencode"],
    });
    await checks.tick();
    await checks.runNow();
    expect(smoked).toEqual(["other", "other"]);
    const why = Object.fromEntries((await checks.info()).agents.map((a) => [a.agent, a.why]));
    expect(why).toEqual({ opencode: "Limited", "grok-build": "Avoided", other: null });
  });

  it("checks one that isn't free, and Claude Code, only when you pick it", async () => {
    const agents = [info("opencode"), info("grok-build"), info("claude-code")];
    const billing: Record<string, Billing> = { "grok-build": "subscription", "claude-code": "free" };
    const plain = setup({ config: nightly, agents, billing });
    await plain.checks.tick();
    expect(plain.smoked).toEqual(["opencode"]);
    const picked = setup({
      config: (c) => ({ ...c, checks: { nightly: true, agents: ["grok-build", "claude-code"] } }),
      agents,
      billing,
    });
    await picked.checks.tick();
    expect(picked.smoked).toEqual(["opencode", "grok-build", "claude-code"]);
    const cost = Object.fromEntries((await picked.checks.info()).agents.map((a) => [a.agent, a.cost]));
    expect(cost["opencode"]).toBe("Free");
    expect(cost["grok-build"]).toBe("A little of your plan");
  });

  it("a failure notifies once", async () => {
    let broken = true;
    const { checks, notes, clock } = setup({
      config: nightly,
      agents: [info("grok-build")],
      result: () => (broken ? BROKEN : OK),
    });
    await checks.tick();
    // Held through quiet hours: said once they end.
    expect(notes).toEqual([]);
    clock.now = at(23, "09:00");
    await checks.tick();
    expect(notes).toEqual(["Grok Build: 2 checks failed"]);
    // Still broken the next night: no new note.
    clock.now = at(24, "02:00");
    await checks.tick();
    clock.now = at(24, "09:00");
    await checks.tick();
    expect(notes).toHaveLength(1);
    // Fixed, then broken again: a new note.
    broken = false;
    clock.now = at(25, "02:00");
    await checks.tick();
    broken = true;
    clock.now = at(26, "02:00");
    await checks.tick();
    clock.now = at(26, "09:00");
    await checks.tick();
    expect(notes).toEqual(["Grok Build: 2 checks failed", "Grok Build: 2 checks failed"]);
  });

  // Live check, 2026-11-28: a failure found at night and found again by Check now before quiet hours ended was never
  // said (the second check dropped the note still waiting).
  it("says a failure still waiting for quiet hours to end, though checked again meanwhile", async () => {
    const { checks, notes, clock } = setup({
      config: nightly,
      agents: [info("grok-build")],
      result: () => BROKEN,
    });
    await checks.tick();
    clock.now = at(23, "05:00");
    await checks.runNow();
    clock.now = at(23, "09:00");
    await checks.tick();
    expect(notes).toEqual(["Grok Build: 2 checks failed"]);
  });

  it("waits while a chat is working", async () => {
    let busy = true;
    const o = setup({ config: nightly, working: () => busy });
    const { checks } = o;
    await checks.tick();
    expect(o.smoked).toEqual([]);
    busy = false;
    await checks.tick();
    expect(o.smoked).toEqual(["opencode"]);
  });
});
