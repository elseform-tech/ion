import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest } from "@ion/adapter-kit";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getHarness } from "../adapters/registry.js";
import { createJudge } from "./judge.js";
import { judgeOthers, readyNow } from "./judge-agents.js";

const req: ApprovalRequest = {
  id: "r",
  kind: "command",
  toolName: "Bash",
  summary: "pnpm test",
  input: { command: "pnpm test" },
};
const input = { projectId: "app", text: "run the tests", req };
/** The agent's pinned judge model, as its adapter says (never written out here). */
const J = (id: string) => `${id}:${getHarness(id)!.adapter.judge!.model}`;
const ALLOW = '{"verdict": "allow", "reason": "fine"}';

/** A config with this judge (and agent order), in a fresh folder. */
function setup(judge: string, order: string[] = []) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ion-judge-agents-")));
  const configFile = join(home, "config.toml");
  saveUserConfig(configFile, {
    ...DEFAULT_CONFIG,
    access: { ...DEFAULT_CONFIG.access, judge },
    routing: { ...DEFAULT_CONFIG.routing, order },
  });
  return { configFile, dataDir: home };
}

/** A judge whose agents in `down` fail (out of quota); every spec it's run on is kept in `tried`. */
function judgeWith(o: {
  judge: string;
  ready: string[];
  down?: string[];
  order?: string[];
  limited?: string[];
}) {
  const tried: string[] = [];
  const logged: string[] = [];
  const run = async (_p: string, _s: AbortSignal, agent?: string) => {
    const spec = agent ?? o.judge;
    tried.push(spec);
    if (o.down?.includes(spec.split(":")[0]!)) throw new Error("free usage is used up");
    return ALLOW;
  };
  const now = { ready: async () => o.ready, limited: (id: string) => !!o.limited?.includes(id) };
  const others = judgeOthers(setup(o.judge, o.order), now, (l) => void logged.push(l));
  return { judge: createJudge(run, 3000, others), tried, logged };
}

// Plan 21 audit, 2026-11-23: with the judge (and ion's quick and deep models) set to opencode and opencode out of its
// free quota, the judge's second try went to Claude Code at its default model (Opus): 3 real Claude calls nobody
// asked for. The judge now goes along your agent order to the next agent that's ready and not limited, at its pinned
// judge model; Claude Code only when it's first in your order or the only one ready; with none left it's unsure
// (you're asked). Which agent it went on is logged once.
// PR #36 review, 2026-11-23: ion's judge goes on its own only on (agent, model) pairs its judge evals checked; one
// you set yourself still runs.
describe("the judge's next agent", () => {
  beforeAll(() => {
    process.env.ION_ALLOW_FAKE = "1";
  });
  afterAll(() => {
    delete process.env.ION_ALLOW_FAKE;
  });

  it("goes along your agent order, past Claude Code, and logs it once", async () => {
    const j = judgeWith({
      judge: "opencode",
      ready: ["claude-code", "opencode", "grok-build"],
      down: ["opencode"],
    });
    expect(await j.judge(input)).toEqual({ verdict: "allow", reason: "fine" });
    await j.judge(input);
    expect(j.tried).toEqual(["opencode", J("grok-build"), "opencode", J("grok-build")]);
    expect(j.logged).toEqual(["ion's judge: opencode didn't answer; it goes on Grok Build"]);
  });

  it("is unsure, never Claude Code, when only Claude Code is left", async () => {
    const j = judgeWith({ judge: "opencode", ready: ["opencode", "claude-code"], down: ["opencode"] });
    expect(await j.judge(input)).toMatchObject({ verdict: "unsure", decided: false });
    expect(j.tried).toEqual(["opencode"]);
    expect(j.logged).toHaveLength(1);
  });

  it("skips a limited agent, and says it's limited", async () => {
    const j = judgeWith({ judge: "opencode", ready: ["opencode", "grok-build"], limited: ["opencode"] });
    await j.judge(input);
    expect(j.tried).toEqual([J("grok-build")]);
    expect(j.logged).toEqual(["ion's judge: opencode is limited; it goes on Grok Build"]);
  });

  it("goes on Claude Code at its judge model when it's first in your order, or the only one ready", async () => {
    const first = judgeWith({
      judge: "opencode",
      ready: ["opencode", "grok-build", "claude-code"],
      down: ["opencode"],
      order: ["claude-code"],
    });
    await first.judge(input);
    expect(first.tried).toEqual(["opencode", J("claude-code")]);
    const alone = judgeWith({ judge: "opencode", ready: ["claude-code"], down: ["opencode"] });
    await alone.judge(input);
    expect(alone.tried).toEqual(["opencode", J("claude-code")]);
  });

  it("starts on the first checked ready agent in your order when you set none", async () => {
    // Codex's pinned judge model isn't checked (its eval allowed a case that must not pass): passed over.
    const j = judgeWith({ judge: "", ready: ["claude-code", "codex", "grok-build"] });
    await j.judge(input);
    expect(j.tried).toEqual([J("grok-build")]);
    const none = judgeWith({ judge: "", ready: ["claude-code", "grok-build"], limited: ["grok-build"] });
    expect(await none.judge(input)).toEqual({
      verdict: "unsure",
      reason: "ion couldn't decide: no agent is ready",
      decided: false,
    });
    expect(none.tried).toEqual([]);
  });

  it("never goes on its own on an agent ion's judge evals haven't checked", async () => {
    // The fake agent has no checked judge model; first in your order, it's passed over.
    const j = judgeWith({ judge: "", ready: ["fake", "grok-build"], order: ["fake"] });
    await j.judge(input);
    expect(j.tried).toEqual([J("grok-build")]);
    const after = judgeWith({
      judge: "grok-build",
      ready: ["grok-build", "fake"],
      down: ["grok-build"],
      order: ["grok-build", "fake"],
    });
    expect(await after.judge(input)).toMatchObject({ verdict: "unsure" });
    expect(after.tried).toEqual(["grok-build"]);
    // One you set yourself still runs.
    const yours = judgeWith({ judge: "fake", ready: ["fake"] });
    await yours.judge(input);
    expect(yours.tried).toEqual(["fake"]);
  });
});

// PR #36 live check, 2026-11-23: with opencode limited, the judge went on to Grok Build in the log, yet answered
// "no agent is ready": the list of agents re-checked every CLI (seconds under load) past the judge's 2 s for it. The
// judge reads what's known, waiting only a moment for a check still going.
describe("the agents the judge reads", () => {
  it("are what's known, without waiting on a slow check", async () => {
    const info = (id: string) => ({
      id,
      label: id,
      installed: true,
      signedIn: true,
      models: [],
      defaultModel: null,
    });
    const waited: number[] = [];
    const infos = {
      soon: async (ms: number) => {
        waited.push(ms);
        return [info("grok-build"), { ...info("codex"), signedIn: false }];
      },
    };
    expect(await readyNow(infos)()).toEqual(["grok-build"]);
    expect(waited[0]).toBeLessThan(2000);
  });
});
