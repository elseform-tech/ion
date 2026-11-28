import type { AdapterEvent } from "@ion/adapter-kit";
import type { Billing } from "@ion/schema";
import { harnessRunner } from "../access/index.js";
import { ownAgents, readyNow } from "../access/judge-agents.js";
import { JudgeChecks } from "../access/judge-check.js";
import { agentOrder, getHarness } from "../adapters/registry.js";
import { loadUserConfig } from "@ion/config";
import { usageView } from "../views/usage.js";
import { strongestBrain } from "../ions/brain.js";
import type { Db } from "../store/index.js";
import { harnessInfos } from "./commands.js";

/** The agents signed in now (what's known; the judge and ion's brain pick from them). */
const readyAgents = readyNow(harnessInfos);

/** How an agent bills on this model: asked of the agent when it can say (opencode's prices), else its sign-in's. */
async function billingOn(agent: string, model: string): Promise<Billing | null> {
  const a = getHarness(agent)?.adapter;
  if (a?.billingOf) return (await a.billingOf([model]).catch(() => undefined)) ?? null;
  return (await harnessInfos.one(agent).catch(() => undefined))?.billing ?? null;
}

/** When ion first looks for free agents to check as judge, then how often (a free agent signed in later is found). */
const FIRST_LOOK_MS = 60_000;
const LOOK_EVERY_MS = 30 * 60_000;

/**
 * ion's own models' runners (PR #36, 2026-11-23): the judge (only on pairs ion checked on your agents, along your
 * order), ion's quick model (low-decision work, your order), ion's brain at Medium (answering from your decisions: the
 * strongest model you have unless you picked one), and ion's checks of each agent's judge model (free agents checked
 * by themselves, quietly, once ready).
 */
export function ownModels(
  opts: { dataDir: string; configFile: string },
  db: Db,
  record: (harness: string, e: AdapterEvent, startedAt: string) => void,
) {
  const state: { judges?: JudgeChecks } = {};
  const strongest = async () => {
    const b = await strongestBrain({
      configFile: opts.configFile,
      db,
      agents: () => harnessInfos.soon(1000),
    });
    return b ? [b.agent, b.model].filter(Boolean).join(":") : undefined;
  };
  const passed = (id: string) => state.judges?.passed(id) ?? false;
  const own = ownAgents({ ...opts, record }, db, { ready: readyAgents, passed, strongest });
  const judge = harnessRunner(own);
  const config = () => loadUserConfig(opts.configFile).config;
  const judges = new JudgeChecks({
    dataDir: opts.dataDir,
    run: judge,
    ready: readyAgents,
    billing: billingOn,
    // Only when it needs one, on Automatic's first free agent, stopping at its limit (Plan 21, 2026-11-28).
    limited: (id) => usageView.agents(db, new Date())[id]?.limitedUntil ?? null,
    avoided: (id) => !!config().agents?.[id]?.avoid,
    order: () => agentOrder(config().routing.order),
  });
  state.judges = judges;
  const look = () => void judges.checkFree().catch(() => undefined);
  setTimeout(look, FIRST_LOOK_MS).unref();
  setInterval(look, LOOK_EVERY_MS).unref();
  return { own, judge, brain: harnessRunner(own, "brain"), judges };
}
