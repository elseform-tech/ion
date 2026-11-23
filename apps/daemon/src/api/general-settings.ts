import { availableParallelism } from "node:os";
import { CLOCK, MAX_RUNS, MIN_RUNS, NOTIFY_LEVELS, ON_LIMIT, type UserConfig } from "@ion/config";
import {
  DREAM_MODES,
  type NotifyLevel,
  type OnLimit,
  type SettingsInfo,
  type SettingsPatch,
} from "@ion/schema";
import { agentOrder, harnessIds } from "../adapters/registry.js";
import { maxRuns } from "../scheduler/index.js";
import { UserError } from "./errors.js";

/** General and Notifications as the app shows them, from your config (what's not set is its default). */
export function generalOf(c: UserConfig): Omit<SettingsInfo, "quick" | "effort" | "ownTools"> {
  return {
    maxRuns: c.resources.max_runs,
    autoRuns: maxRuns("auto", availableParallelism()),
    notifications: {
      briefing: { on: c.notifications.briefing.on, at: c.notifications.briefing.at },
      quiet: {
        on: c.notifications.quiet.on,
        from: c.notifications.quiet.from,
        to: c.notifications.quiet.to,
      },
      projects: Object.fromEntries(c.projects.map((p) => [p.id, p.notify ?? "needs"])),
    },
    dream: { mode: c.memory.dream, agent: c.memory.dreamAgent ?? null },
    agentOrder: agentOrder(c.routing.order),
    onLimit: c.routing.onLimit,
    byUsage: c.routing.byUsage,
  };
}

/** Your agent order: agents ion knows, each once (the rest follow in ion's own order). */
function order(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length) throw new UserError("Name the agents in order");
  const ids = v.map(String);
  const unknown = ids.find((id) => !harnessIds().includes(id));
  if (unknown) throw new UserError(`Unknown agent: ${unknown}`);
  return [...new Set(ids)];
}

function onLimit(v: unknown): OnLimit {
  if (!ON_LIMIT.includes(v as OnLimit)) throw new UserError("Pick ask, continue or wait");
  return v as OnLimit;
}

/** ion's dream changed: how often (checked), and its agent (one ion knows; null: ion's own model's again). */
function dreamPatch(m: UserConfig["memory"], p: SettingsPatch["dream"]): UserConfig["memory"] {
  if (!p) return m;
  if (p.mode !== undefined && !DREAM_MODES.includes(p.mode))
    throw new UserError("Pick off, nightly or weekly");
  const next = { ...m, ...(p.mode ? { dream: p.mode } : {}) };
  if (p.agent === null) delete next.dreamAgent;
  else if (p.agent !== undefined) {
    if (!harnessIds().includes(String(p.agent).split(":")[0]!))
      throw new UserError(`Unknown agent: ${p.agent}`);
    next.dreamAgent = p.agent;
  }
  return next;
}

function flag(v: unknown): boolean {
  if (typeof v !== "boolean") throw new UserError("Pick on or off");
  return v;
}

function clock(v: unknown): string {
  if (typeof v !== "string" || !CLOCK.test(v)) throw new UserError("Use a time like 08:30");
  return v;
}

function runs(v: unknown): "auto" | number {
  if (v === "auto") return v;
  if (typeof v !== "number" || !Number.isInteger(v) || v < MIN_RUNS || v > MAX_RUNS)
    throw new UserError(`Between ${MIN_RUNS} and ${MAX_RUNS} chats`);
  return v;
}

function level(v: unknown): NotifyLevel {
  if (!NOTIFY_LEVELS.includes(v as NotifyLevel)) throw new UserError("Pick all, needs, digest or muted");
  return v as NotifyLevel;
}

/** One group's fields, each checked by `check`; a field not in the patch stays. */
function merged<T extends object>(
  now: T,
  patch: object | undefined,
  check: Record<string, (v: unknown) => unknown>,
): T {
  const next = { ...now } as Record<string, unknown>;
  const given = (patch ?? {}) as Record<string, unknown>;
  for (const [k, f] of Object.entries(check)) if (given[k] !== undefined) next[k] = f(given[k]);
  return next as T;
}

function projectLevels(
  c: UserConfig,
  levels: Record<string, NotifyLevel> | undefined,
): UserConfig["projects"] {
  for (const id of Object.keys(levels ?? {}))
    if (!c.projects.some((p) => p.id === id)) throw new UserError(`Unknown project: ${id}`);
  return c.projects.map((p) => (levels && p.id in levels ? { ...p, notify: level(levels[p.id]) } : p));
}

/** The config with the patch applied; the first bad value refuses the whole patch, in plain words. */
export function applyGeneral(c: UserConfig, patch: SettingsPatch): UserConfig {
  const n = patch.notifications;
  return {
    ...c,
    resources: patch.maxRuns === undefined ? c.resources : { ...c.resources, max_runs: runs(patch.maxRuns) },
    notifications: {
      ...c.notifications,
      briefing: merged(c.notifications.briefing, n?.briefing, { on: flag, at: clock }),
      quiet: merged(c.notifications.quiet, n?.quiet, { on: flag, from: clock, to: clock }),
    },
    projects: projectLevels(c, n?.projects),
    memory: dreamPatch(c.memory, patch.dream),
    routing: merged(
      c.routing,
      { order: patch.agentOrder, onLimit: patch.onLimit, byUsage: patch.byUsage },
      { order, onLimit, byUsage: flag },
    ),
  };
}
