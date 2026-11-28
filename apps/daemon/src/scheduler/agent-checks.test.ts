import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig, type UserConfig } from "@ion/config";
import { type AgentCheckItem, type Billing, checkLines, type HarnessInfo } from "@ion/schema";
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
  /** The last thing that happened in ion (an event), when there was one. */
  lastEvent?: () => Date | null;
  /** The smoke moves the clock (a check takes time). */
  takes?: number;
  dataDir?: string;
  judge?: (agent: string) => Promise<AgentCheckItem | null>;
  judgeCost?: (agent: string, billing: Billing | null) => string | null;
}) {
  const dataDir = o.dataDir ?? realpathSync(mkdtempSync(join(tmpdir(), "ion-agent-checks-")));
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), "ion-agent-checks-config-")));
  const cf = join(o.dataDir ? configDir : dataDir, "config.toml");
  saveUserConfig(cf, (o.config ?? ((c) => c))(structuredClone(DEFAULT_CONFIG)));
  const smoked: string[] = [];
  const notes: string[] = [];
  const clock = { now: at(23, "02:00") };
  const deps: AgentChecksDeps = {
    dataDir,
    configFile: cf,
    agents: async () => o.agents ?? [info("opencode")],
    limited: (id) => (o.limited ?? []).includes(id),
    billing: async (id) => o.billing?.[id] ?? "free",
    model: () => null,
    smoke: async (agent) => {
      smoked.push(agent);
      if (o.takes) clock.now = new Date(clock.now.getTime() + o.takes);
      return (o.result ?? (() => OK))(agent);
    },
    notify: (body) => notes.push(body),
    ...(o.judge ? { judge: o.judge } : {}),
    ...(o.judgeCost ? { judgeCost: o.judgeCost } : {}),
    working: o.working ?? (() => false),
    lastEvent: o.lastEvent ?? (() => null),
    now: () => clock.now,
  };
  return { checks: new AgentChecks(deps), smoked, notes, clock, configFile: cf };
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
    off.clock.now = at(24, "02:30");
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
    expect(notes).toEqual(["Grok Build: 2 checks failed · last night"]);
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
    expect(notes).toEqual([
      "Grok Build: 2 checks failed · last night",
      "Grok Build: 2 checks failed · last night",
    ]);
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
    expect(notes).toEqual(["Grok Build: 2 checks failed · today at 05:00"]);
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

  // Task 5 review, 2026-11-28: an agent whose use is used up isn't broken; the check says so, notes nothing, and its
  // limit mark (set from the error the check recorded) keeps it out until it resets.
  it("knows a used-up agent from a broken one", async () => {
    const limited: string[] = [];
    const { checks, notes, smoked, clock } = setup({
      config: nightly,
      limited,
      result: () => {
        limited.push("opencode");
        return [
          { name: "Starts", ok: true },
          { name: "Answers", ok: true, limited: true, note: "Its free use is used up" },
        ];
      },
    });
    await checks.tick();
    clock.now = at(23, "09:00");
    await checks.tick();
    expect(notes).toEqual([]);
    const info = await checks.info();
    expect(checkLines(info.last, clock.now)).toEqual(["opencode: its free use is used up · last night"]);
    clock.now = at(24, "02:00");
    await checks.tick();
    expect(smoked).toEqual(["opencode"]);
    expect(info.agents[0]).toMatchObject({ why: "Limited" });
  });

  // Plan 21 final review (2026-11-28, I2): the judge's check ran after a used-up smoke, spending what was left. An agent
  // used up (its smoke says so, or it's marked limited) gets no judge check that night; a paid one says what its judge
  // check costs beside the night's.
  it("no judge check on a used-up agent, and a paid one says what its judge check costs", async () => {
    const judged: string[] = [];
    const judge = async (agent: string) => {
      judged.push(agent);
      return { name: "Judge", ok: true };
    };
    const used = setup({
      config: nightly,
      judge,
      result: () => [{ name: "Answers", ok: true, limited: true, note: "Its free use is used up" }],
    });
    await used.checks.tick();
    expect(used.smoked).toEqual(["opencode"]);
    expect(judged).toEqual([]);
    const fine = setup({ config: nightly, judge });
    await fine.checks.tick();
    expect(judged).toEqual(["opencode"]);
    const paid = setup({
      config: (c) => ({ ...nightly(c), checks: { nightly: true, agents: ["codex"] } }),
      agents: [info("codex")],
      billing: { codex: "api" },
      judgeCost: (agent, billing) =>
        billing === "api" ? `${agent}'s judge check: 59 short questions` : null,
    });
    expect((await paid.checks.info()).agents[0]).toMatchObject({
      cost: "About a cent a night · codex's judge check: 59 short questions",
    });
  });

  // Task 5 review: only on a quiet night: quiet hours an hour old, nothing in ion for 30 minutes, and no new agent
  // started in the window's last 30 minutes.
  it("waits for a quiet night", async () => {
    let last: Date | null = at(23, "01:50");
    const o = setup({ config: nightly, lastEvent: () => last });
    o.clock.now = at(22, "22:30");
    await o.checks.tick();
    o.clock.now = at(23, "02:10");
    await o.checks.tick();
    expect(o.smoked).toEqual([]);
    o.clock.now = at(23, "02:25");
    await o.checks.tick();
    expect(o.smoked).toEqual(["opencode"]);
    last = null;
    const late = setup({ config: nightly, agents: [info("a"), info("b")], takes: 20 * 60_000 });
    late.clock.now = at(23, "07:20");
    await late.checks.tick();
    expect(late.smoked).toEqual(["a"]);
    const end = setup({ config: nightly });
    end.clock.now = at(23, "07:40");
    await end.checks.tick();
    expect(end.smoked).toEqual([]);
  });

  it("says when: last night only for the night's check", async () => {
    const { checks, clock } = setup({ config: nightly });
    clock.now = at(23, "14:05");
    await checks.runNow();
    expect(checkLines((await checks.info()).last, at(23, "15:00"))).toEqual([
      "Checked today at 14:05: all fine",
    ]);
    expect(checkLines((await checks.info()).last, at(24, "10:00"))).toEqual([
      "Checked yesterday at 14:05: all fine",
    ]);
    clock.now = at(24, "02:00");
    await checks.tick();
    expect(checkLines((await checks.info()).last, at(24, "10:00"))).toEqual(["Checked last night: all fine"]);
  });

  it("checks once a night though its file can't be written, and a check now in the night counts as the night's", async () => {
    const gone = join(realpathSync(mkdtempSync(join(tmpdir(), "ion-agent-checks-gone-"))), "missing");
    const o = setup({ config: nightly, dataDir: gone });
    await o.checks.tick();
    o.clock.now = at(23, "03:00");
    await o.checks.tick();
    expect(o.smoked).toEqual(["opencode"]);
    const now = setup({ config: nightly });
    now.clock.now = at(23, "01:00");
    await now.checks.runNow();
    now.clock.now = at(23, "02:00");
    await now.checks.tick();
    expect(now.smoked).toEqual(["opencode"]);
  });

  it("with quiet hours off, holds a failure's note until 06:00", async () => {
    const { checks, notes, clock } = setup({
      config: (c) =>
        nightly({
          ...c,
          notifications: { ...c.notifications, quiet: { ...c.notifications.quiet, on: false } },
        }),
      agents: [info("grok-build")],
      result: () => BROKEN,
    });
    clock.now = at(23, "03:00");
    await checks.tick();
    clock.now = at(23, "05:30");
    await checks.tick();
    expect(notes).toEqual([]);
    clock.now = at(23, "06:10");
    await checks.tick();
    expect(notes).toEqual(["Grok Build: 2 checks failed · last night"]);
  });
});
