import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { judgePin } from "../adapters/registry.js";
import { JUDGE_CASES } from "../evals/judge-cases.js";
import { harnessRunner } from "./runner.js";
import { JudgeChecks, judgeCheckTime, runJudgeCheck } from "./judge-check.js";

// PR #36 re-review, the user, 2026-11-23: "harnesses can be different and not everyone has Claude". ion checks the
// judge on your own agents: each adapter pins a judge model, and ion runs its judge eval cases (the same prompt, no
// tools) on it, keeping "checked on your Mac" per agent, model and date. It passes with nothing dangerous allowed.
// Free agents are checked by themselves when first ready; paid ones only when you ask. A new pinned model is checked
// again. The judge goes only on checked pairs (Grok's ships checked); Claude Code is no special case.

const env = { ...process.env };
beforeEach(() => {
  process.env.ION_ALLOW_FAKE = "1";
});
afterEach(() => {
  process.env = { ...env };
});

const answer = (verdict: string) => async () => JSON.stringify({ verdict, reason: "x" });

function setup() {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "ion-judge-check-")));
  const configFile = join(dataDir, "config.toml");
  saveUserConfig(configFile, DEFAULT_CONFIG);
  return { dataDir, configFile };
}

describe("ion's check of a judge model", () => {
  it("fails a model that allows what must not pass, and passes one that allows nothing dangerous", async () => {
    const lax = await runJudgeCheck(answer("allow"), { parallel: 8 });
    expect(lax.pass).toBe(false);
    expect(lax.dangerous).toHaveLength(JUDGE_CASES.filter((c) => c.expect !== "allow").length);
    expect(lax.cases).toBe(JUDGE_CASES.length);
    const strict = await runJudgeCheck(answer("deny"), { parallel: 8 });
    expect(strict).toMatchObject({ pass: true, dangerous: [], unsure: 0 });
    expect(strict.agreement).toBe(
      JUDGE_CASES.filter((c) => c.expect === "deny" || c.expect === "ask").length,
    );
  });

  // Live check, 2026-11-24: an agent out of its quota gives no verdict at all; "nothing dangerous allowed" isn't a
  // pass then, and such a run isn't kept (a free agent is checked again once it answers).
  it("doesn't pass a model that mostly gave no verdict, nor keep that run", async () => {
    const down = await runJudgeCheck(async () => {
      throw new Error("free usage is used up");
    });
    expect(down).toMatchObject({ pass: false, dangerous: [] });
    expect(down.failed).toBe(JUDGE_CASES.length);
    const o = setup();
    const checks = new JudgeChecks({
      ...o,
      run: async () => {
        throw new Error("free usage is used up");
      },
      ready: async () => ["fake"],
      billing: async () => "free",
    });
    await expect(checks.check("fake")).rejects.toThrow("gave no verdict");
    expect(checks.last("fake")).toBeUndefined();
  });

  // PR #36 final review, 2026-11-24: a check that gave no verdict on more than a tenth of the cases is never kept
  // (here about a fifth), and a free agent whose check can't run is tried again the next day, not every half hour.
  it("keeps no check with too many cases unanswered, and tries a failing free agent once a day", async () => {
    const o = setup();
    let n = 0;
    const someFail = async () => {
      n++;
      if (n % 5 === 0) throw new Error("timed out");
      return JSON.stringify({ verdict: "deny", reason: "x" });
    };
    const checks = new JudgeChecks({
      ...o,
      run: someFail,
      ready: async () => ["fake"],
      billing: async () => "free",
    });
    await expect(checks.check("fake")).rejects.toThrow("gave no verdict");
    expect(checks.last("fake")).toBeUndefined();
    let tries = 0;
    // Its own home: the check above is kept as today's try (none doubles up).
    const down = new JudgeChecks({
      ...setup(),
      run: async () => {
        tries++;
        throw new Error("free usage is used up");
      },
      ready: async () => ["fake"],
      billing: async () => "free",
      pace: { gapMs: 0, capMs: 60_000 },
    });
    await down.checkFree();
    const once = tries;
    expect(once).toBeGreaterThan(0);
    await down.checkFree();
    expect(tries).toBe(once);
  });

  it("checks the fake agent's pinned judge model for real, keeps the record, and checks a new model again", async () => {
    const o = setup();
    const run = harnessRunner(o);
    const ready = async () => ["fake"];
    const checks = new JudgeChecks({ ...o, run, ready, billing: async () => "subscription" });
    // The fake judge allows anything not marked deny-me: dangerous.
    const lax = await checks.check("fake");
    expect(lax).toMatchObject({ agent: "fake", model: judgePin("fake")!.split(":")[1], pass: false });
    expect(checks.passed("fake")).toBe(false);
    process.env.ION_FAKE_JUDGE = "deny";
    expect(await checks.check("fake")).toMatchObject({ pass: true, dangerous: [] });
    expect(checks.passed("fake")).toBe(true);
    // A new pinned model isn't checked until it's run.
    process.env.ION_FAKE_JUDGE_MODEL = "fake-judge-2";
    expect(checks.passed("fake")).toBe(false);
  });

  it("checks a free agent by itself when it's first ready, never a paid one", async () => {
    const o = setup();
    process.env.ION_FAKE_JUDGE = "deny";
    const run = harnessRunner(o);
    const paid = new JudgeChecks({
      ...o,
      run,
      ready: async () => ["fake"],
      billing: async () => "subscription",
    });
    expect(await paid.checkFree()).toEqual([]);
    expect(paid.passed("fake")).toBe(false);
    const pace = { gapMs: 0, capMs: 60_000 };
    const free = new JudgeChecks({
      ...o,
      run,
      ready: async () => ["fake"],
      billing: async () => "free",
      pace,
    });
    expect(await free.checkFree()).toEqual(["fake"]);
    expect(free.passed("fake")).toBe(true);
    // Once checked, not again.
    expect(await free.checkFree()).toEqual([]);
  });

  it("counts Grok's pinned model as checked: ion ran it before shipping", () => {
    const o = setup();
    const checks = new JudgeChecks({
      ...o,
      run: harnessRunner(o),
      ready: async () => [],
      billing: async () => null,
    });
    expect(checks.passed("grok-build")).toBe(true);
    expect(checks.passed("claude-code")).toBe(false);
  });
});

// Plan 21, 2026-11-28: a fresh ion checked a free agent as judge by itself, and the 59 cases used up opencode's whole
// free quota (19 usage reports, then 38 limit errors in a minute), once a day on every fresh home. It checks one only
// when it needs one (no checked judge ready), only the first free agent in Automatic's choice, a case at a time with
// a gap and a cap on the time; it stops at the first limit (the agent marked limited, nothing kept) and tries again
// no sooner than the limit's reset.
describe("ion's own check of a free agent", () => {
  const verdict = async () => JSON.stringify({ verdict: "deny", reason: "x" });
  type Opts = Partial<ConstructorParameters<typeof JudgeChecks>[0]>;
  const make = (o: Opts) =>
    new JudgeChecks({
      ...setup(),
      run: verdict,
      ready: async () => [],
      billing: async () => "free",
      pace: { gapMs: 0, capMs: 60_000 },
      ...o,
    });

  it("checks none while a checked judge is ready, and only the first free one when none is", async () => {
    const tried: string[] = [];
    const run = async (_p: string, _s: AbortSignal, spec?: string) => (tried.push(spec!), verdict());
    const ready = make({ run, ready: async () => ["grok-build", "fake", "opencode"] });
    expect(await ready.checkFree()).toEqual([]);
    expect(tried).toEqual([]);
    const limited = (id: string) => (id === "grok-build" ? "2026-12-01T00:00:00.000Z" : null);
    const none = make({
      run,
      limited,
      order: () => ["fake", "opencode"],
      ready: async () => ["grok-build", "fake", "opencode"],
    });
    expect(await none.checkFree()).toEqual(["fake"]);
    expect(new Set(tried.map((s) => s.split(":")[0]))).toEqual(new Set(["fake"]));
  });

  it("stops at the first limit, keeps nothing, and waits for the reset", async () => {
    let calls = 0;
    let until: string | null = null;
    const run = async () => {
      calls++;
      if (calls === 3) {
        until = new Date(Date.now() + 3600_000).toISOString();
        throw new Error("free usage is used up");
      }
      return verdict();
    };
    const c = make({ run, limited: (id) => (id === "fake" ? until : null), ready: async () => ["fake"] });
    await c.checkFree();
    expect(calls).toBe(3);
    expect(c.last("fake")).toBeUndefined();
    expect(c.status("fake")).toEqual({ ranOut: true });
    until = null;
    await c.checkFree();
    expect(calls).toBe(3);
  });

  // Flaked on GitHub's macOS runners (PR #49 CI, 2026-11-28: "expected 1 to be greater than 1"): the real clock let a
  // slow first case eat the whole 100 ms cap. Time is virtual here (a gap only moves the clock), so the count is exact.
  it("runs a case at a time with a gap, within a cap on its time", async () => {
    let t = 0;
    let running = 0;
    let overlapped = false;
    const starts: number[] = [];
    const run = async () => {
      overlapped ||= ++running > 1;
      starts.push(t);
      await Promise.resolve();
      running--;
      return verdict();
    };
    const clock = {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
    const c = make({ run, clock, ready: async () => ["fake"], pace: { gapMs: 30, capMs: 100 } });
    await c.checkFree();
    // Starts at 0, 30, 60, 90; the gap after the fourth passes the cap (120 > 100), so no fifth.
    expect(starts).toEqual([0, 30, 60, 90]);
    expect(overlapped).toBe(false);
    expect(c.last("fake")).toBeUndefined();
  });
});

// Plan 21 final review (2026-11-28, I2): the nightly check's judge check ran all 59 cases at once, at no pace, with a
// limit counted as a failure and nothing kept for the day. It goes like ion's own check: a case at a time within the
// cap, tried once a day (judge-tries.json), and a limit is "used up" (limited, no note), not a failed check.
describe("the nightly judge check", () => {
  const verdict = async () => JSON.stringify({ verdict: "deny", reason: "x" });
  const make = (o: Partial<ConstructorParameters<typeof JudgeChecks>[0]>) =>
    new JudgeChecks({
      ...setup(),
      run: verdict,
      ready: async () => ["fake"],
      billing: async () => "free",
      pace: { gapMs: 30, capMs: 100 },
      ...o,
    });

  it("is paced and capped, kept for the day, and says used up at a limit", async () => {
    let calls = 0;
    const paced = make({ run: async () => (calls++, verdict()) });
    expect(await paced.checkItem("fake")).toMatchObject({ name: "Judge", ok: false });
    expect(calls).toBeLessThan(6);
    // Tried today: ion's own check doesn't try it again by itself.
    expect(await paced.checkFree()).toEqual([]);
    let until: string | null = null;
    const out = make({
      pace: { gapMs: 0, capMs: 60_000 },
      limited: () => until,
      run: async () => {
        until = new Date(Date.now() + 3600_000).toISOString();
        throw new Error("free usage is used up");
      },
    });
    expect(await out.checkItem("fake")).toEqual({ name: "Judge", ok: true, limited: true });
  });
});

// Plan 21's final review, 2026-11-28: ion's own check of a free agent ran a minute after a fresh ion started, at any
// hour, so a beginner's first session shared the free quota with it. It runs only on a quiet night: quiet hours at
// least an hour old (else 01:00–06:00) with nothing happening for 30 minutes, and never before your first answer.
// "Check as judge" still runs at once, and every attempt is kept so none doubles up.
describe("when ion checks a free agent by itself", () => {
  const quiet = { on: true, from: "22:00", to: "08:00" };
  const at = (h: number, m = 0) => new Date(2026, 10, 28, h, m);
  const ok = { quiet, answered: true };
  it("only on a quiet night, idle, after your first answer", () => {
    expect(judgeCheckTime({ ...ok, now: at(22, 30), lastEventAt: at(21) })).toBe(false);
    expect(judgeCheckTime({ ...ok, now: at(23, 30), lastEventAt: at(23, 10) })).toBe(false);
    expect(judgeCheckTime({ ...ok, now: at(23, 30), lastEventAt: at(22, 50) })).toBe(true);
    expect(judgeCheckTime({ ...ok, now: at(14), lastEventAt: at(9) })).toBe(false);
    expect(judgeCheckTime({ ...ok, now: at(23, 30), lastEventAt: at(22), answered: false })).toBe(false);
    const off = { ...quiet, on: false };
    expect(judgeCheckTime({ ...ok, quiet: off, now: at(3), lastEventAt: at(1) })).toBe(true);
    expect(judgeCheckTime({ ...ok, quiet: off, now: at(7), lastEventAt: at(1) })).toBe(false);
  });

  it("doesn't run again the day you checked it yourself", async () => {
    let calls = 0;
    const o = setup();
    const c = new JudgeChecks({
      ...o,
      run: async () => (calls++, JSON.stringify({ verdict: "deny", reason: "x" })),
      ready: async () => ["fake"],
      billing: async () => "free",
      pace: { gapMs: 0, capMs: 60_000 },
    });
    await c.check("fake").catch(() => undefined);
    const yours = calls;
    rmSync(join(o.dataDir, "judge-checks.json"), { force: true });
    expect(await c.checkFree()).toEqual([]);
    expect(calls).toBe(yours);
  });
});
