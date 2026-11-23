import { join } from "node:path";
import { loadUserConfig } from "@ion/config";
import type { HarnessInfo } from "@ion/schema";
import {
  agentLabel,
  agentOrder,
  byPreference,
  judgePin,
  nextInOrder,
  quickSpec,
} from "../adapters/registry.js";
import type { Db } from "../store/index.js";
import { usageView } from "../views/usage.js";
import { createJudge, type JudgeOthers } from "./judge.js";
import { useJudgeMisses } from "./misses.js";

/** The agents signed in now, and whether one is limited (Plan 20's usage marks). */
export type AgentsNow = { ready: () => Promise<string[]>; limited: (id: string) => boolean };

/** How long the judge waits for a check of the agents still going: well within its own 2 s for the list. */
const READY_WAIT_MS = 1000;

/**
 * The agents signed in, as the judge reads them: what's known, waiting a moment at most for a check still going (PR
 * #36 live check, 2026-11-23: a full re-check of every CLI took longer than the judge's 2 s, so it found none).
 */
export const readyNow =
  (infos: { soon: (ms: number) => Promise<HarnessInfo[]> }) => async (): Promise<string[]> =>
    (await infos.soon(READY_WAIT_MS)).filter((h) => h.installed && h.signedIn).map((h) => h.id);

/** The agents signed in now and whether one is limited (Plan 20's marks): where ion's own models may go. */
export const agentsNow = (db: Db, ready: () => Promise<string[]>): AgentsNow => ({
  ready,
  limited: (id) => !!usageView.agents(db, new Date())[id]?.limitedUntil,
});

const orderOf = (configFile: string) => agentOrder(loadUserConfig(configFile).config.routing.order);

/** Whether ion checked an agent's pinned judge model (on this computer, or before shipping it). */
export type Passed = (agent: string) => boolean;

/**
 * The next agent ion's judge may go on by itself (PR #36 re-review, 2026-11-23): the first in your order that's ready,
 * not limited, not one of `not`, and whose pinned judge model ion checked, at that model; Claude Code like any other.
 */
async function nextChecked(
  o: { configFile: string; now: AgentsNow; passed: Passed },
  not: string[] = [],
): Promise<string | undefined> {
  const c = loadUserConfig(o.configFile).config;
  // Never one you avoid (the user, 2026-11-24).
  const usable = (id: string) =>
    o.passed(id) && !not.includes(id) && !o.now.limited(id) && !c.agents?.[id]?.avoid;
  const id = byPreference((await o.now.ready()).filter(usable), agentOrder(c.routing.order))[0];
  return id && judgePin(id);
}

/**
 * The agent ion's own model goes on when your config names none: for the judge, the first checked one along your
 * order (nextChecked); for ion's quick model (low-decision work), the first in your order that's ready and not limited
 * (Claude Code only first in your order or alone ready). None: undefined.
 */
export async function firstOwn(
  o: { configFile: string; now: AgentsNow; passed: Passed },
  which: "judge" | "quick",
): Promise<string | undefined> {
  if (which === "judge") return nextChecked(o);
  const id = nextInOrder({
    order: orderOf(o.configFile),
    ready: await o.now.ready(),
    limited: o.now.limited,
  });
  return id && quickSpec(id);
}

/**
 * Where Auto's judge runs (Plan 21 audit; PR #36 re-review, 2026-11-23): the agent you set (one that's limited is
 * skipped), else the first along your agent order whose pinned judge model ion checked on your agents; when that one
 * fails or is slow, the next such one. Never a pair ion hasn't checked unless you set it. Each miss is counted for its
 * agent (Settings → Agents); which agent it went on, and why, is logged once.
 */
export function judgeOthers(
  o: { dataDir: string; configFile: string; passed: Passed },
  now: AgentsNow,
  log: (line: string) => void = console.warn,
): JudgeOthers {
  const misses = useJudgeMisses(join(o.dataDir, "judge-misses.json"));
  const said = new Set<string>();
  const at = { configFile: o.configFile, now, passed: o.passed };
  const next = async (failed: string, why = "didn't answer") => {
    const spec = await nextChecked(at, [failed]);
    const id = spec?.split(":")[0];
    const line = id
      ? `ion's judge: ${agentLabel(failed)} ${why}; it goes on ${agentLabel(id)}`
      : `ion's judge: ${agentLabel(failed)} ${why} and no other checked agent is ready; you're asked`;
    if (!said.has(line)) log(line);
    said.add(line);
    return spec;
  };
  return {
    first: async () => {
      const set = loadUserConfig(o.configFile).config.access.judge ?? "";
      const id = set.split(":")[0]!;
      if (set && !now.limited(id)) return set;
      if (set) return next(id, "is limited");
      return nextChecked(at);
    },
    next,
    missed: (agent) => misses.add(agent),
  };
}

/** Auto's judge on this runner: your judge's agent, else the next along your agent order (Plan 21 audit, 2026-11-23). */
export const judgeOn = (
  o: { dataDir: string; configFile: string; now: AgentsNow; passed: Passed },
  run: (prompt: string, signal: AbortSignal, agent?: string) => Promise<string>,
) => createJudge(run, undefined, judgeOthers(o, o.now));

/** ion's own agent processes' options with where they may go: the agents now, and the first ready when none is set. */
export function ownAgents<T extends { configFile: string }>(
  o: T,
  db: Db,
  w: { ready: () => Promise<string[]>; passed: Passed; strongest: () => Promise<string | undefined> },
) {
  const now = agentsNow(db, w.ready);
  const at = { configFile: o.configFile, now, passed: w.passed };
  const first = (which: "judge" | "quick" | "brain") =>
    which === "brain" ? w.strongest() : firstOwn(at, which);
  return { ...o, now, passed: w.passed, firstOwn: first };
}
