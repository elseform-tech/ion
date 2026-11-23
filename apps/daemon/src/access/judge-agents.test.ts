import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest } from "@ion/adapter-kit";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { describe, expect, it } from "vitest";
import { createJudge } from "./judge.js";
import { judgeOthers } from "./judge-agents.js";

const req: ApprovalRequest = {
  id: "r",
  kind: "command",
  toolName: "Bash",
  summary: "pnpm test",
  input: { command: "pnpm test" },
};
const input = { projectId: "app", text: "run the tests", req };
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
// asked for. The judge now goes along your agent order to the next agent that's ready and not limited, at its quick
// model; Claude Code only when it's first in your order or the only one ready; with none left it's unsure (you're
// asked). Which agent it went on is logged once.
describe("the judge's next agent", () => {
  it("goes along your agent order, past Claude Code, and logs it once", async () => {
    const j = judgeWith({
      judge: "opencode",
      ready: ["claude-code", "opencode", "grok-build"],
      down: ["opencode"],
    });
    expect(await j.judge(input)).toEqual({ verdict: "allow", reason: "fine" });
    await j.judge(input);
    expect(j.tried).toEqual(["opencode", "grok-build", "opencode", "grok-build"]);
    expect(j.logged).toHaveLength(1);
    expect(j.logged[0]).toContain("Grok Build");
  });

  it("is unsure, never Claude Code, when only Claude Code is left", async () => {
    const j = judgeWith({ judge: "opencode", ready: ["opencode", "claude-code"], down: ["opencode"] });
    expect(await j.judge(input)).toMatchObject({ verdict: "unsure", decided: false });
    expect(j.tried).toEqual(["opencode"]);
    expect(j.logged).toHaveLength(1);
  });

  it("skips a limited agent", async () => {
    const j = judgeWith({
      judge: "opencode",
      ready: ["opencode", "grok-build", "codex"],
      down: ["opencode"],
      limited: ["grok-build"],
    });
    await j.judge(input);
    expect(j.tried).toEqual(["opencode", "codex"]);
  });

  it("goes on Claude Code at its quick model when it's first in your order, or the only one ready", async () => {
    const first = judgeWith({
      judge: "opencode",
      ready: ["opencode", "grok-build", "claude-code"],
      down: ["opencode"],
      order: ["claude-code"],
    });
    await first.judge(input);
    expect(first.tried).toEqual(["opencode", "claude-code:haiku"]);
    const alone = judgeWith({ judge: "opencode", ready: ["claude-code"], down: ["opencode"] });
    await alone.judge(input);
    expect(alone.tried).toEqual(["opencode", "claude-code:haiku"]);
  });

  it("starts on the first ready agent in your order when you set none, at its quick model", async () => {
    const j = judgeWith({
      judge: "",
      ready: ["claude-code", "grok-build", "opencode"],
      limited: ["opencode"],
    });
    await j.judge(input);
    expect(j.tried).toEqual(["grok-build"]);
    const none = judgeWith({ judge: "", ready: ["claude-code", "opencode"], limited: ["opencode"] });
    expect(await none.judge(input)).toMatchObject({ verdict: "unsure", decided: false });
    expect(none.tried).toEqual([]);
  });
});
