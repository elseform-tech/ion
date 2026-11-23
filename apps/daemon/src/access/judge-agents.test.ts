import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest } from "@ion/adapter-kit";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { judgePin, shippedChecked } from "../adapters/registry.js";
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
const J = (id: string) => judgePin(id)!;
const ALLOW = '{"verdict": "allow", "reason": "fine"}';

/** A config with this judge (and agent order), in a fresh folder. */
function setup(judge: string, order: string[] = [], avoid: string[] = []) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ion-judge-agents-")));
  const configFile = join(home, "config.toml");
  saveUserConfig(configFile, {
    ...DEFAULT_CONFIG,
    access: { ...DEFAULT_CONFIG.access, judge },
    routing: { ...DEFAULT_CONFIG.routing, order },
    agents: Object.fromEntries(avoid.map((id) => [id, { avoid: true }])),
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
  /** Agents whose pinned judge model ion checked on this computer (Grok's ships checked). */
  checked?: string[];
  avoid?: string[];
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
  const passed = (id: string) => shippedChecked(id) || !!o.checked?.includes(id);
  const at = setup(o.judge, o.order, o.avoid);
  const others = judgeOthers({ ...at, passed }, now, (l) => void logged.push(l));
  return { judge: createJudge(run, 3000, others), tried, logged };
}

// Plan 21 audit, 2026-11-23: with the judge (and ion's quick and deep models) set to opencode and opencode out of its
// free quota, the judge's second try went to Claude Code at its default model (Opus): 3 real Claude calls nobody
// asked for. The judge goes along your agent order to the next agent that's ready and not limited, at its pinned
// judge model; with none left it's unsure (you're asked). Which agent it went on is logged once.
// PR #36 re-review, the user, 2026-11-23: only on agents whose pinned judge model ion checked (on your Mac, or before
// shipping: Grok's); Claude Code like any other. One you set yourself still runs.
describe("the judge's next agent", () => {
  beforeAll(() => {
    process.env.ION_ALLOW_FAKE = "1";
  });
  afterAll(() => {
    delete process.env.ION_ALLOW_FAKE;
  });

  it("goes along your agent order to the next checked agent, and logs it once", async () => {
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

  it("is unsure when no other checked agent is ready, and never an unchecked Claude Code", async () => {
    const j = judgeWith({ judge: "opencode", ready: ["opencode", "claude-code"], down: ["opencode"] });
    expect(await j.judge(input)).toMatchObject({ verdict: "unsure", decided: false });
    expect(j.tried).toEqual(["opencode"]);
    expect(j.logged).toEqual([
      "ion's judge: opencode didn't answer and no other checked agent is ready; you're asked",
    ]);
  });

  it("skips a limited agent, and says it's limited", async () => {
    const j = judgeWith({ judge: "opencode", ready: ["opencode", "grok-build"], limited: ["opencode"] });
    await j.judge(input);
    expect(j.tried).toEqual([J("grok-build")]);
    expect(j.logged).toEqual(["ion's judge: opencode is limited; it goes on Grok Build"]);
  });

  it("goes on Claude Code like any other once it's checked on your Mac, along your order", async () => {
    const j = judgeWith({
      judge: "",
      ready: ["grok-build", "claude-code"],
      order: ["claude-code", "grok-build"],
      checked: ["claude-code"],
    });
    await j.judge(input);
    expect(j.tried).toEqual([J("claude-code")]);
  });

  it("starts on the first checked ready agent in your order when you set none", async () => {
    // Codex's pinned judge model isn't checked here: passed over.
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

  // The user, 2026-11-24: an agent you marked "Avoid unless I ask" isn't picked as judge either.
  it("passes over an agent you avoid", async () => {
    const j = judgeWith({
      judge: "",
      ready: ["fake", "grok-build"],
      order: ["fake"],
      checked: ["fake"],
      avoid: ["fake"],
    });
    await j.judge(input);
    expect(j.tried).toEqual([J("grok-build")]);
  });

  it("goes on an agent checked on your Mac, and still runs one you set yourself", async () => {
    const j = judgeWith({ judge: "", ready: ["fake", "grok-build"], order: ["fake"], checked: ["fake"] });
    await j.judge(input);
    expect(j.tried).toEqual([J("fake")]);
    const yours = judgeWith({ judge: "codex", ready: ["codex"] });
    await yours.judge(input);
    expect(yours.tried).toEqual(["codex"]);
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
