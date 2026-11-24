import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { judgePin } from "../adapters/registry.js";
import { JUDGE_CASES } from "../evals/judge-cases.js";
import { harnessRunner } from "./runner.js";
import { JudgeChecks, runJudgeCheck } from "./judge-check.js";

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
    const down = new JudgeChecks({
      ...o,
      run: async () => {
        tries++;
        throw new Error("free usage is used up");
      },
      ready: async () => ["fake"],
      billing: async () => "free",
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
    const free = new JudgeChecks({ ...o, run, ready: async () => ["fake"], billing: async () => "free" });
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
