import { type AgentCheckItem, type Billing, EV } from "@ion/schema";
import { JUDGE_CASES } from "../evals/judge-cases.js";
import { ownAgentStart } from "../access/runner.js";
import type { JudgeChecks } from "../access/judge-check.js";
import { getHarness, judgePin, shippedChecked } from "../adapters/registry.js";
import { limitedUntil } from "../ions/brain.js";
import type { GateAnswer } from "../gate/server.js";
import { CHECK_ION } from "../mcp/check-tool.js";
import type { Grants, IonScope } from "../mcp/index.js";
import { AgentChecks } from "../scheduler/agent-checks.js";
import { AgentSmoke } from "../scheduler/agent-smoke.js";
import type { Dreams } from "../scheduler/dreams.js";
import type { Db, EventStore } from "../store/index.js";
import { runsView } from "../views/runs.js";
import { recordTo } from "../views/usage.js";
import { harnessInfos } from "./commands.js";
import { billingOn } from "./own-models.js";

/** The nightly check and the checks' own sessions (their gate). */
export type AgentChecking = { checks: AgentChecks; smoke: AgentSmoke };

/** The model an agent's check runs on: its small judge model (PR #36's pin), else its own default. */
const modelOf = (id: string): string | null => judgePin(id)?.split(":").slice(1).join(":") || null;

/** Whether the agent's judge is checked again tonight: its pinned judge model changed since its last check here. */
const judgeDue = (judges: JudgeChecks | undefined, agent: string): judges is JudgeChecks =>
  !!judges &&
  !!judgePin(agent) &&
  !shippedChecked(agent) &&
  !judges.last(agent) &&
  judges.records().some((r) => r.agent === agent);

/**
 * The judge checked again only when the agent's pinned judge model changed (PR #36), paced and kept for the day like
 * ion's own check, a limit "used up" (Plan 21 final review). Nothing to check: null.
 */
const judgeAgain =
  (judges: JudgeChecks | undefined) =>
  async (agent: string): Promise<AgentCheckItem | null> =>
    judgeDue(judges, agent) ? judges.checkItem(agent) : null;

/** What the judge's check costs a paid agent tonight, said plainly (its cases are short questions). */
function judgeCost(judges: JudgeChecks | undefined) {
  return (agent: string, billing: Billing | null): string | null => {
    if (!judgeDue(judges, agent)) return null;
    const n = `its judge check: ${JUDGE_CASES.length} short questions`;
    if (billing === "api") return `${n}, about $0.05–0.10`;
    return billing === "subscription" ? `${n} from your plan` : null;
  };
}

/**
 * "Check the agents each night" (Plan 21 Task 5): the checks (each a real, small session of the agent with ion's
 * tools and gate), on ion's own agents' footing (your keys kept from them, sandboxed); a failure a "needs you" note.
 */
export function agentChecking(d: {
  store: EventStore;
  db: Db;
  dataDir: string;
  configFile: string;
  grants: Grants;
  base: () => string;
  judges?: JudgeChecks;
  /** Whether ion is tidying memory now. */
  tidying?: () => boolean;
}): AgentChecking {
  const smoke = new AgentSmoke({
    ...{ dataDir: d.dataDir, configFile: d.configFile, grants: d.grants },
    mcpUrl: () => `${d.base()}/mcp`,
    gateUrl: () => `${d.base()}/gate`,
    adapter: (id) => getHarness(id)?.adapter,
    info: async (id) => {
      await harnessInfos.refresh(id);
      return harnessInfos.one(id);
    },
    own: (cwd, harness) => ownAgentStart(d, cwd, harness),
    // Its usage and a limit it hits go in its agent's ledger: the limit mark keeps it out until it resets.
    record: recordTo(d.store),
  });
  const checks = new AgentChecks({
    ...{ dataDir: d.dataDir, configFile: d.configFile },
    agents: (waitMs) => harnessInfos.soon(waitMs),
    limited: (id) => !!limitedUntil(d.db, id),
    billing: async (id, model) =>
      model ? billingOn(id, model) : ((await harnessInfos.one(id))?.billing ?? null),
    model: modelOf,
    smoke: (agent, model, signal) => smoke.run(agent, model, signal),
    judge: judgeAgain(d.judges),
    judgeCost: judgeCost(d.judges),
    notify: (body) =>
      d.store.append({
        ...{ chatId: "notify", runId: null, origin: "daemon", type: EV.notify },
        data: { title: "ion", body, kind: "needs" },
      }),
    // A chat's run going or waiting: the check waits for an idle computer.
    // The last thing that happened in ion, but its notifications (a quiet night: nothing for 30 minutes).
    lastEvent: () => {
      const e = d.store.read({ newest: true, limit: 20 }).findLast((x) => x.chatId !== "notify");
      return e ? new Date(e.ts) : null;
    },
    // Tidying memory counts too: the two never run at once (Plan 21 final review, M10).
    working: () =>
      !!d.tidying?.() || runsView.rows(d.db).some((r) => r.status === "running" || r.status === "queued"),
  });
  // It looks every few minutes from now on; ion's close stops it (and a check going) first.
  checks.start();
  return { checks, smoke };
}

/** ion's gate for ions' keys: a check's calls go to its check, every other ion's to `rest` (ions' turns). */
export function checksGate(
  checking: AgentChecking | undefined,
  rest: (scope: IonScope, payload: unknown) => Promise<GateAnswer | null>,
) {
  return (scope: IonScope, payload: unknown): Promise<GateAnswer | null> =>
    scope.ionId === CHECK_ION && checking
      ? Promise.resolve(checking.smoke.gate(scope, payload))
      : rest(scope, payload);
}

/** The nightly check and Tidy memory, each waiting while the other goes (Plan 21 final review, M10). */
export function checksBeside(dreams: Dreams, make: (tidying: () => boolean) => AgentChecking): AgentChecking {
  const checking = make(() => dreams.tidying);
  dreams.waitFor(() => checking.checks.checking);
  return checking;
}
