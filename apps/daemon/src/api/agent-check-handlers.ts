import type { UserConfig } from "@ion/config";
import { harnessIds } from "../adapters/registry.js";
import type { AgentChecks } from "../scheduler/agent-checks.js";
import type { Ctx, Handlers } from "./commands.js";
import { UserError } from "./errors.js";
import { changeConfig } from "./settings.js";

/** Your picks of agents that aren't free, by id: added or taken out. */
function picked(c: UserConfig, pick: Record<string, boolean>): string[] {
  const ids = new Set(c.checks.agents);
  for (const [id, on] of Object.entries(pick)) {
    if (!harnessIds().includes(id)) throw new UserError(`Unknown agent: ${id}`);
    if (on) ids.add(id);
    else ids.delete(id);
  }
  return [...ids];
}

const need = (ctx: Ctx): AgentChecks => {
  if (!ctx.agentChecks) throw new UserError("ion can't check its agents yet");
  return ctx.agentChecks.checks;
};

export const agentCheckHandlers: Pick<Handlers, "agents.checks" | "agents.check"> = {
  "agents.checks": (a, ctx) => {
    const checks = need(ctx);
    if (a.nightly !== undefined || a.pick)
      changeConfig(ctx.configFile, (c) => ({
        ...c,
        checks: {
          ...c.checks,
          ...(a.nightly !== undefined ? { nightly: a.nightly === true } : {}),
          ...(a.pick ? { agents: picked(c, a.pick) } : {}),
        },
      }));
    return checks.info();
  },
  "agents.check": (_a, ctx) => need(ctx).runNow(),
};
