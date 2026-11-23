import { join } from "node:path";
import { loadUserConfig } from "@ion/config";
import type { HarnessInfo } from "@ion/schema";
import { agentLabel, agentOrder, judgeSpec, nextInOrder, quickSpec } from "../adapters/registry.js";
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

/** Agents ion's judge may go on by itself: those with a pinned judge model its evals checked. */
const checked = (ids: string[]) => ids.filter((id) => judgeSpec(id));

/**
 * The agent ion's own model goes on when your config names none (a fresh ion follows your agent order): the first in
 * your order that's ready and not limited (Claude Code only first in your order or alone ready); for the judge, only
 * one ion's judge evals checked, at that model. None: undefined.
 */
export async function firstOwn(
  configFile: string,
  now: AgentsNow,
  which: "judge" | "quick",
): Promise<string | undefined> {
  const ready = await now.ready();
  const order = orderOf(configFile);
  if (which === "quick") {
    const id = nextInOrder({ order, ready, limited: now.limited });
    return id && quickSpec(id);
  }
  const id = nextInOrder({ order, ready: checked(ready), limited: now.limited, signedIn: ready });
  return id && judgeSpec(id);
}

/**
 * Where Auto's judge runs (Plan 21 audit, 2026-11-23): the agent you set (else the first ready in your order that
 * ion's judge evals checked, at that model; PR #36 review), skipping one that's limited; then, when that one fails or
 * is slow, the next checked one along your agent order that's ready and not limited, never quietly Claude Code. Each
 * miss is counted for its agent (Settings → Agents); which agent it went on, and why, is logged once.
 */
export function judgeOthers(
  o: { dataDir: string; configFile: string },
  now: AgentsNow,
  log: (line: string) => void = console.warn,
): JudgeOthers {
  const misses = useJudgeMisses(join(o.dataDir, "judge-misses.json"));
  const said = new Set<string>();
  const next = async (failed: string, why = "didn't answer") => {
    const ready = await now.ready();
    const id = nextInOrder({
      ...{ order: orderOf(o.configFile), ready: checked(ready), signedIn: ready },
      ...{ limited: now.limited, not: [failed] },
    });
    const line = id
      ? `ion's judge: ${agentLabel(failed)} ${why}; it goes on ${agentLabel(id)}`
      : `ion's judge: ${agentLabel(failed)} ${why} and no other agent is ready; you're asked`;
    if (!said.has(line)) log(line);
    said.add(line);
    return id && judgeSpec(id);
  };
  return {
    first: async () => {
      const set = loadUserConfig(o.configFile).config.access.judge ?? "";
      const id = set.split(":")[0]!;
      if (set && !now.limited(id)) return set;
      if (set) return next(id, "is limited");
      return firstOwn(o.configFile, now, "judge");
    },
    next,
    missed: (agent) => misses.add(agent),
  };
}

/** Auto's judge on this runner: your judge's agent, else the next along your agent order (Plan 21 audit, 2026-11-23). */
export const judgeOn = (
  o: { dataDir: string; configFile: string; now: AgentsNow },
  run: (prompt: string, signal: AbortSignal, agent?: string) => Promise<string>,
) => createJudge(run, undefined, judgeOthers(o, o.now));

/** ion's own agent processes' options with where they may go: the agents now, and the first ready when none is set. */
export function ownAgents<T extends { configFile: string }>(o: T, db: Db, ready: () => Promise<string[]>) {
  const now = agentsNow(db, ready);
  return { ...o, now, firstOwn: (which: "judge" | "quick") => firstOwn(o.configFile, now, which) };
}
