import { DEFAULT_PROJECT, loadUserConfig, PROFILE_CHARS, saveUserConfig, type UserConfig } from "@ion/config";
import { chatsView } from "../views/chats.js";
import { runsView } from "../views/runs.js";
import { type EffortLevel, type ProjectPatch, type SettingsInfo, stripControl } from "@ion/schema";
import { applyGeneral, generalOf } from "./general-settings.js";
import { harnessIds, judgeChecked } from "../adapters/registry.js";
import { agentsNow, firstOwn } from "../access/judge-agents.js";
import type { Db } from "../store/index.js";
import { harnessInfos } from "./commands.js";
import { ownSwitches } from "../tools/own-run.js";
import type { Handlers } from "./commands.js";
import { UserError } from "./errors.js";

/** Loads your config, changes it, saves it; a refusal (or a config that doesn't parse) is the error you see. */
export function changeConfig(file: string, change: (c: UserConfig) => UserConfig): void {
  const { config, error } = loadUserConfig(file);
  if (error) throw new UserError(`Fix your config first. ${error}`);
  try {
    saveUserConfig(file, change(config));
  } catch (e) {
    throw new UserError((e as Error).message);
  }
}

const EFFORTS = ["low", "medium", "high", "max"];

/** "<agent>" or "<agent>:<model>", with an agent ion knows. */
function checkAgent(spec: string): string {
  const id = spec.split(":")[0] ?? "";
  if (!harnessIds().includes(id)) throw new UserError(`Unknown agent: ${id}`);
  return spec;
}

/** Each field of the patch checked; undefined: leave it, null: clear it. */
function checked(p: ProjectPatch): Omit<ProjectPatch, "projectId"> {
  if (p.harness) checkAgent(p.harness);
  if (p.color && !/^#[0-9a-fA-F]{6}$/.test(p.color)) throw new UserError("Pick a colour");
  if (p.effort && !EFFORTS.includes(p.effort)) throw new UserError("Pick low, medium, high or max");
  if (p.model !== undefined && p.model !== null && !p.model.trim()) throw new UserError("Pick a model");
  return onlyPatchable({ ...p, ...profileOf(p) });
}

/**
 * A profile as saved: trimmed, without control characters; empty clears it. A suggestion is its ion's to write: the
 * app only clears one (you accepted or dismissed it).
 */
function profileOf({ profile, profileSuggestion }: ProjectPatch): Pick<ProjectPatch, "profile"> {
  if (profileSuggestion !== undefined && profileSuggestion !== null)
    throw new UserError("Only its ion suggests a profile");
  if (profile === undefined || profile === null) return profile === null ? { profile } : {};
  if (typeof profile !== "string") throw new UserError("Write the profile as text");
  const text = stripControl(profile).trim();
  if (text.length > PROFILE_CHARS) throw new UserError(`Keep it under ${PROFILE_CHARS} characters`);
  return { profile: text || null };
}

const PATCHABLE = [
  "harness",
  "color",
  "model",
  "effort",
  "shareWithIon",
  "profile",
  "profileSuggestion",
] as const;

/** Only the fields Settings may change: anything else sent (a path, an id) is never written. */
function onlyPatchable(p: ProjectPatch): Omit<ProjectPatch, "projectId"> {
  const fields: Record<string, unknown> = {};
  for (const k of PATCHABLE) if (k in p) fields[k] = p[k];
  return fields as Omit<ProjectPatch, "projectId">;
}

/** Sets the given fields on one project; a null removes the field (its default applies again). */
function patchProject(c: UserConfig, p: ProjectPatch): UserConfig {
  if (!c.projects.some((x) => x.id === p.projectId)) throw new UserError(`Unknown project: ${p.projectId}`);
  const fields = checked(p);
  return {
    ...c,
    projects: c.projects.map((x) => {
      if (x.id !== p.projectId) return x;
      const next: Record<string, unknown> = { ...x };
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        if (v === null) delete next[k];
        else next[k] = v;
      }
      return next as typeof x;
    }),
  };
}

/** ion's own model and effort changed: undefined leaves one as it is; a null effort is the agent's default again. */
function ionPatch(
  ion: UserConfig["ion"],
  quick: string | null | undefined,
  effort: EffortLevel | null | undefined,
) {
  const next = { ...ion, ...(quick ? { quick } : {}) };
  if (quick === null) delete next.quick;
  if (effort === null) delete next.quickEffort;
  else if (effort) next.quickEffort = effort;
  return next;
}

/** "Use its own tools" by agent, checked: an agent ion knows, on or off. */
function ownPatch(given: Record<string, boolean> | undefined) {
  const entries = Object.entries(given ?? {});
  for (const [id, on] of entries) {
    checkAgent(id);
    if (typeof on !== "boolean") throw new UserError("Pick on or off");
  }
  return (agents: UserConfig["agents"]): UserConfig["agents"] => {
    const next = { ...agents };
    for (const [id, on] of entries) next[id] = { ...next[id], ownTools: on };
    return next;
  };
}

/**
 * How long Settings waits for a check of the agents still going: a moment (it's read on every change; the app reads
 * Settings again when the agents' list comes, so whom they follow shows then).
 */
const READY_MS = 300;

/** `f`'s promise, asked for at most once. */
function lazy<T>(f: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => {
    p ??= f();
    return p;
  };
}

/** "<agent>[:<model>]" checked; null or "" is null (your agent order again); undefined leaves it. */
function specPatch(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  return v ? checkAgent(String(v)) : null;
}

/** The judge patched: a spec, or none (your agent order again). */
function accessPatch(access: UserConfig["access"], judge: string | null | undefined): UserConfig["access"] {
  if (judge === undefined) return access;
  const next = { ...access };
  if (judge === null) delete next.judge;
  else next.judge = judge;
  return next;
}

/**
 * Every setting as your config file has it (when it doesn't load, the defaults and why), and whom ion's quick model
 * and the judge run on now (PR #36 review, 2026-11-23: the daemon says, from your order, the agents ready and limited).
 */
async function settingsOf(file: string, db: Db): Promise<SettingsInfo> {
  const { config: c, error } = loadUserConfig(file);
  // What's known of the agents, waiting a moment at most for a first check (asked only for what isn't set).
  const ready = lazy(async () =>
    (await harnessInfos.soon(READY_MS)).filter((h) => h.installed && h.signedIn).map((h) => h.id),
  );
  const now = agentsNow(db, ready);
  const judgeNow = c.access.judge || ((await firstOwn(file, now, "judge")) ?? null);
  const settings = {
    ...{ quick: c.ion.quick ?? "", effort: c.ion.quickEffort ?? null, judge: c.access.judge ?? "" },
    quickNow: c.ion.quick || ((await firstOwn(file, now, "quick")) ?? null),
    ...{ judgeNow, judgeChecked: !!judgeNow && judgeChecked(judgeNow) },
    ...generalOf(c),
    ownTools: ownSwitches(c),
  };
  return error ? { ...settings, problem: error } : settings;
}

/** Settings: a project ion's setup and rules, ion's own quick model, and Auto's judge. */
export const settingsHandlers: Pick<
  Handlers,
  "project.update" | "settings.get" | "settings.set" | "ion.stats"
> = {
  "ion.stats": (a, ctx) => {
    const ionId = String(a.ionId ?? "");
    const known =
      ionId === "chief" || loadUserConfig(ctx.configFile).config.projects.some((p) => p.id === ionId);
    if (!known || ionId === DEFAULT_PROJECT) throw new UserError(`Unknown ion: ${ionId}`);
    const threads = chatsView
      .list(ctx.db)
      .filter((c) => c.by === "ion" && (ionId === "chief" || c.projectId === ionId))
      .map((c) => c.chatId);
    return runsView.stats(ctx.db, threads, new Date());
  },
  "project.update": (a, ctx) => {
    changeConfig(ctx.configFile, (c) => patchProject(c, a));
    return { ok: true as const };
  },
  "settings.get": (_a, ctx) => settingsOf(ctx.configFile, ctx.db),
  "settings.set": (a, ctx) => {
    const p = a.patch ?? {};
    const quick = specPatch(p.quick);
    const judge = specPatch(p.judge);
    if (p.effort && !EFFORTS.includes(p.effort)) throw new UserError("Pick low, medium, high or max");
    const own = ownPatch(p.ownTools);
    changeConfig(ctx.configFile, (c) => ({
      ...applyGeneral(c, p),
      ion: ionPatch(c.ion, quick, p.effort),
      access: accessPatch(c.access, judge),
      agents: own(c.agents),
    }));
    // A higher limit lets waiting runs start now.
    ctx.runs.limitChanged();
    return settingsOf(ctx.configFile, ctx.db);
  },
};
