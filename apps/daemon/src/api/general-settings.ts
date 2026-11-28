import { availableParallelism } from "node:os";
import {
  CLOCK,
  MAX_RUNS,
  MIN_RUNS,
  NOTIFY_LEVELS,
  projectRemembered,
  setMemory,
  type UserConfig,
  youRemembered,
} from "@ion/config";
import {
  DREAM_MODES,
  NOTIFY_DEFAULTS,
  type IonSettings,
  type NotifyLevel,
  type SettingsInfo,
  type SettingsPatch,
} from "@ion/schema";
import { agentOrder, harnessIds } from "../adapters/registry.js";
import { maxRuns } from "../scheduler/index.js";
import { UserError } from "./errors.js";

/** General and Notifications as the app shows them, from your config (what's not set is its default). */
export function generalOf(c: UserConfig): Omit<SettingsInfo, keyof IonSettings | "ownTools"> {
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
      projects: Object.fromEntries(c.projects.map((p) => [p.id, p.notify ?? NOTIFY_DEFAULTS.level])),
    },
    dream: { mode: c.memory.dream, agent: c.memory.dreamAgent ?? null },
    memory: {
      on: youRemembered(c),
      projects: Object.fromEntries(c.projects.map((p) => [p.id, projectRemembered(c, p.id)])),
    },
    agentOrder: agentOrder(c.routing.order),
    prefer: c.routing.order,
    chats: c.ion.chats ?? "",
    lastPick: lastPickOf(c),
    chatsEffort: c.ion.chatsEffort ?? null,
    avoid: Object.fromEntries(
      Object.entries(c.agents ?? {})
        .filter(([, a]) => a?.avoid)
        .map(([id]) => [id, true as const]),
    ),
  };
}

/** Your last pick in the composer (the user, 2026-11-24), or null. */
function lastPickOf(c: UserConfig): SettingsInfo["lastPick"] {
  const last = c.composer?.last;
  if (!last) return null;
  const [harness, ...rest] = last.split(":");
  return { harness: harness!, model: rest.join(":"), effort: c.composer?.lastEffort ?? "" };
}

/** Your last pick, saved as given (an agent ion knows), or cleared. */
function composerPatch(c: UserConfig, p: SettingsPatch["lastPick"]): UserConfig["composer"] {
  if (p === undefined) return c.composer;
  if (p === null) return {};
  if (!harnessIds().includes(p.harness)) throw new UserError(`Unknown agent: ${p.harness}`);
  const last = p.model ? `${p.harness}:${p.model}` : p.harness;
  return { last, ...(p.effort ? { lastEffort: p.effort } : {}) };
}

/** "Prefer in this order": agents ion knows, each once; empty: Automatic decides (the user, 2026-11-24). */
function order(v: unknown): string[] {
  if (!Array.isArray(v)) throw new UserError("Name the agents in order");
  const ids = v.map(String);
  const unknown = ids.find((id) => !harnessIds().includes(id));
  if (unknown) throw new UserError(`Unknown agent: ${unknown}`);
  return [...new Set(ids)];
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

/**
 * Memory on or off (the user, 2026-11-23): each project given (one set like everywhere follows it again), then
 * everywhere (a project you turned off stays off).
 */
function memoryPatch(c: UserConfig, p: SettingsPatch["memory"]): UserConfig {
  if (!p) return c;
  let next = c;
  for (const [id, on] of Object.entries(p.projects ?? {})) {
    if (!next.projects.some((x) => x.id === id)) throw new UserError(`Unknown project: ${id}`);
    next = setMemory(next, flag(on), id);
  }
  return p.on === undefined ? next : setMemory(next, flag(p.on));
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
export function applyGeneral(was: UserConfig, patch: SettingsPatch): UserConfig {
  const n = patch.notifications;
  const c = memoryPatch(was, patch.memory);
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
    routing: merged(c.routing, { order: patch.agentOrder }, { order }),
    composer: composerPatch(c, patch.lastPick),
  };
}
