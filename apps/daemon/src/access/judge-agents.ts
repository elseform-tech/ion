import { join } from "node:path";
import { loadUserConfig } from "@ion/config";
import { agentLabel, agentOrder, nextInOrder, quickSpec } from "../adapters/registry.js";
import type { Db } from "../store/index.js";
import { usageView } from "../views/usage.js";
import { createJudge, type JudgeOthers } from "./judge.js";
import { useJudgeMisses } from "./misses.js";

/** The agents signed in now, and whether one is limited (Plan 20's usage marks). */
export type AgentsNow = { ready: () => Promise<string[]>; limited: (id: string) => boolean };

/** The agents signed in now and whether one is limited (Plan 20's marks): where ion's own models may go. */
const agentsNow = (db: Db, ready: () => Promise<string[]>): AgentsNow => ({
  ready,
  limited: (id) => !!usageView.agents(db, new Date())[id]?.limitedUntil,
});

const orderOf = (configFile: string) => agentOrder(loadUserConfig(configFile).config.routing.order);

/**
 * The agent ion's own model goes on when your config names none (a fresh ion: "" follows your agent order): the
 * first in your order that's ready and not limited (Claude Code only first in your order or alone ready).
 */
async function firstOwnAgent(configFile: string, now: AgentsNow): Promise<string | undefined> {
  return nextInOrder({ order: orderOf(configFile), ready: await now.ready(), limited: now.limited });
}

/** ion's own model's agent when your config names none: the first ready in your order, at its quick model. */
const firstOwnOf = (configFile: string, now: AgentsNow) => async (): Promise<string | undefined> => {
  const id = await firstOwnAgent(configFile, now);
  return id && quickSpec(id);
};

/**
 * Where Auto's judge runs (Plan 21 audit, 2026-11-23): the agent you set (else the first ready in your order, at its
 * quick model; one that's limited is skipped), then, when that one fails or is slow, the next along your agent order
 * that's ready and not limited, at its quick model, never quietly Claude Code. Each miss is counted for its agent
 * (Settings → Agents); which agent it went on is logged once.
 */
export function judgeOthers(
  o: { dataDir: string; configFile: string },
  now: AgentsNow,
  log: (line: string) => void = console.warn,
): JudgeOthers {
  const misses = useJudgeMisses(join(o.dataDir, "judge-misses.json"));
  const said = new Set<string>();
  const next = async (failed: string) => {
    const id = nextInOrder({
      ...{ order: orderOf(o.configFile), ready: await now.ready() },
      ...{ limited: now.limited, not: [failed] },
    });
    const line = id
      ? `ion's judge: ${agentLabel(failed)} didn't answer; it goes on ${agentLabel(id)}`
      : `ion's judge: ${agentLabel(failed)} didn't answer and no other agent is ready; you're asked`;
    if (!said.has(line)) log(line);
    said.add(line);
    return id && quickSpec(id);
  };
  return {
    first: async () => {
      const set = loadUserConfig(o.configFile).config.access.judge ?? "";
      const id = set.split(":")[0]!;
      if (set && !now.limited(id)) return set;
      if (set) return next(id);
      const first = await firstOwnAgent(o.configFile, now);
      return first && quickSpec(first);
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
  return { ...o, now, firstOwn: firstOwnOf(o.configFile, now) };
}
