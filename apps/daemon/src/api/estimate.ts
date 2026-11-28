import { DEFAULT_PROJECT, loadUserConfig } from "@ion/config";
import type { Commands, HarnessInfo, TaskEstimate } from "@ion/schema";
import type { Db } from "../store/index.js";
import { chatAsk, type EstimateAsk, estimateOf } from "../views/estimate.js";
import { routeBy, usageNow, usualAgent } from "./routing.js";

type Ctx = { db: Db; configFile: string };
type Ask = Commands["usage.estimate"]["args"];

/** A new chat's request, on the agent you picked, else the one it would go on (Automatic's, else usualAgent). */
function newAsk(ctx: Ctx, a: Exclude<Ask, { chatId: string }>, ready: string[], pick: () => string | null) {
  const text = String(a.text ?? "").trim();
  const harness = a.harness || pick() || usualAgent(ctx.configFile, ready, null);
  if (!text || !harness) return null;
  return { projectId: a.projectId ?? DEFAULT_PROJECT, harness, text };
}

/**
 * What a task usually takes (the brain pill's hover before you send; an ion's thread line): from similar past chats
 * in its project, on its agent, as it bills. Nothing is sent anywhere; null when there are too few to say.
 */
export async function estimateFor(ctx: Ctx, a: Ask, known: HarnessInfo[]): Promise<TaskEstimate | null> {
  const usage = await usageNow(ctx, known);
  const ready = usage.map((u) => u.harness);
  const c = loadUserConfig(ctx.configFile).config;
  // Pick by usage's pick already worked out what the request usually takes on it: that one, not a second time.
  let route: ReturnType<typeof routeBy> = null;
  const routed = () => {
    if ("chatId" in a || a.harness) return null;
    route = routeBy(c, usage, {
      db: ctx.db,
      text: a.text,
      ...(a.projectId ? { projectId: a.projectId } : {}),
    });
    return route?.harness ?? null;
  };
  const q: EstimateAsk | null =
    "chatId" in a ? chatAsk(ctx.db, String(a.chatId)) : newAsk(ctx, a, ready, routed);
  if (!q) return null;
  const picked = route as ReturnType<typeof routeBy>;
  if (picked?.harness === q.harness) return picked.estimate ?? null;
  const u = usage.find((x) => x.harness === q.harness);
  return estimateOf(ctx.db, q, { billing: u?.billing ?? null, windows: u?.windows ?? [] });
}
