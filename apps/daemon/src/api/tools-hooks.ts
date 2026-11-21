import { randomUUID } from "node:crypto";
import { type HookEntry, loadUserConfig, type UserConfig } from "@ion/config";
import {
  AUTO_APPROVAL,
  type Commands,
  HOOK_EVENTS,
  type HookEvent,
  type HookGroup,
  type HookInfo,
  type NewHook,
} from "@ion/schema";
import { BUILT_IN, CATALOG, type Hooks } from "../hooks/index.js";
import { consentOf, type HookHash, hookHasher, usableHooks, withConsent } from "../hooks/consent.js";
import type { Sign } from "../secrets/consent-key.js";
import { CANT_READ_KEYCHAIN } from "../secrets/index.js";
import { UserError } from "./errors.js";
import { changeConfig } from "./settings.js";

/** A hook as the app sees it: on only while it runs what you turned on, and its last result. */
function hookInfo(h: HookEntry, c: UserConfig, hooks: Hooks, hash: HookHash): HookInfo {
  const { id, name, event, run, project } = h;
  const last = hooks.last(id);
  const consent = consentOf(h, c.tools.hooksOn, hash);
  return {
    ...{ id, name, on: consent.on, event: event as HookEvent, run },
    ...(consent.new ? { new: true as const } : {}),
    ...(consent.changed || consent.unverified ? { changed: true as const } : {}),
    ...(project ? { project } : {}),
    ...(last ? { last } : {}),
  };
}

/** Every event a hook can run on, in order, each with its hooks; ion's own Auto-approval on Before a tool runs. */
export async function hookGroups(c: UserConfig, hooks: Hooks, sign: Sign): Promise<HookGroup[]> {
  const mine = usableHooks(c.tools.hooks);
  const hash = await hookHasher(sign, mine);
  return CATALOG.map(({ event, name }) => ({
    event,
    name,
    ...(event === BUILT_IN.event ? { builtIn: { name: BUILT_IN.name } } : {}),
    hooks: mine.filter((h) => h.event === event).map((h) => hookInfo(h, c, hooks, hash)),
  }));
}

function hookIndex(c: UserConfig, id: string): number {
  if (id === AUTO_APPROVAL) throw new UserError("Auto-approval is built in");
  const i = c.tools.hooks.findIndex((h) => h.id === id);
  if (i < 0) throw new UserError(`Unknown hook: ${id}`);
  return i;
}

const withHooks = (c: UserConfig, hooks: HookEntry[], hooksOn: string[]): UserConfig => ({
  ...c,
  tools: { ...c.tools, hooks, hooksOn },
});

/** Whether a record you made in the app verifies for exactly what this hook runs now (whether it's on or off). */
const consented = (h: HookEntry, hooksOn: string[], hash: HookHash) =>
  consentOf({ ...h, on: true }, hooksOn, hash).on;

/** Turning a hook on in the app is consent to exactly what it runs now; turning it off takes that back. */
function setHookOn(c: UserConfig, id: string, on: boolean, hash: HookHash): UserConfig {
  const i = hookIndex(c, id);
  const h = { ...c.tools.hooks[i]!, on };
  return withHooks(
    c,
    c.tools.hooks.map((x, j) => (j === i ? h : x)),
    withConsent(c.tools.hooksOn, h, on, hash),
  );
}

function text(v: unknown, max: number, empty: string): string {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) throw new UserError(empty);
  if (t.length > max) throw new UserError(`Keep it under ${max} characters`);
  return t;
}

type HookInput = Partial<Omit<NewHook, "project">> & { project?: string | null };
type HookDraft = {
  id: string;
  name: string;
  on: boolean;
  event: string;
  run: string;
  project?: string | null;
};

/** A hook's fields as given, each checked; a field not given stays as it is (a null project: every project). */
function hookFields(c: UserConfig, a: HookInput): Partial<HookDraft> {
  const f: Partial<HookDraft> = {};
  if (a.name !== undefined) f.name = text(a.name, 80, "Name it");
  if (a.run !== undefined) f.run = text(a.run, 4000, "Say what to run");
  if (a.event !== undefined) {
    if (!HOOK_EVENTS.includes(a.event)) throw new UserError("Pick when it runs");
    f.event = a.event;
  }
  if (a.project !== undefined && a.project !== null && !c.projects.some((p) => p.id === a.project))
    throw new UserError(`Unknown project: ${String(a.project)}`);
  if (a.project !== undefined) f.project = a.project;
  return f;
}

/** The hook as saved: no project means every project's events. */
function saved({ project, ...rest }: HookDraft): HookEntry {
  return (project ? { ...rest, project } : rest) as HookEntry;
}

/**
 * A hook you add in the app is on at once: adding it is your consent to it. One added with ion's commands (`off`) has
 * no consent: it's New, and runs only once you turn it on in the app.
 */
function addHook(c: UserConfig, a: NewHook, o: { id: string; off?: true }, hash: HookHash): UserConfig {
  const f = hookFields(c, {
    name: a.name ?? "",
    run: a.run ?? "",
    event: a.event ?? ("" as HookEvent),
    project: a.project,
  });
  const hook = saved({ id: o.id, on: true, ...f } as HookDraft);
  const hooksOn = o.off ? c.tools.hooksOn : withConsent(c.tools.hooksOn, hook, true, hash);
  return withHooks(c, [...c.tools.hooks, hook], hooksOn);
}

/**
 * A hook you change in the app keeps your consent (your own change), unless it was added or changed by hand since
 * you last turned it on: that one stays off until you turn it on.
 */
function updateHook(c: UserConfig, a: Commands["tools.updateHook"]["args"], hash: HookHash): UserConfig {
  const i = hookIndex(c, String(a.id ?? ""));
  const was = c.tools.hooks[i]!;
  const f = hookFields(c, { name: a.name, run: a.run, event: a.event, project: a.project });
  const next = saved({ ...was, ...f });
  const hooksOn = consented(was, c.tools.hooksOn, hash)
    ? withConsent(c.tools.hooksOn, next, true, hash)
    : c.tools.hooksOn;
  return withHooks(
    c,
    c.tools.hooks.map((h, j) => (j === i ? next : h)),
    hooksOn,
  );
}

function removeHook(c: UserConfig, id: string, hash: HookHash): UserConfig {
  const i = hookIndex(c, id);
  const h = c.tools.hooks[i]!;
  return withHooks(
    c,
    c.tools.hooks.filter((_h, j) => j !== i),
    withConsent(c.tools.hooksOn, h, false, hash),
  );
}

type Change = (c: UserConfig, hash: HookHash) => UserConfig;

/**
 * Changes your hooks in ion's config: consent marks are signed (with ion's key) for the hooks as they are now and as
 * the change leaves them, then the change is made on the config as saved.
 */
async function changeHooks(o: { configFile: string; sign: Sign }, change: Change): Promise<void> {
  const now = loadUserConfig(o.configFile).config;
  const after = change(now, () => "-");
  const hash = await hookHasher(o.sign, [...now.tools.hooks, ...after.tools.hooks]);
  try {
    changeConfig(o.configFile, (c) => change(c, hash));
  } catch (e) {
    throw (e as Error).message === CANT_READ_KEYCHAIN ? new UserError(CANT_READ_KEYCHAIN) : e;
  }
}

/** What the app asks of your hooks; each answers with what Settings → Tools shows next. */
export function hookChange(
  o: { configFile: string; sign: Sign },
  a:
    | { op: "add"; args: NewHook; id?: string; off?: true }
    | { op: "update"; args: Commands["tools.updateHook"]["args"] }
    | { op: "remove" | "on" | "off"; id: string },
): Promise<void> {
  if (a.op === "add") {
    const id = a.id ?? `h-${randomUUID().slice(0, 8)}`;
    return changeHooks(o, (c, hash) => addHook(c, a.args, { id, ...(a.off ? { off: a.off } : {}) }, hash));
  }
  if (a.op === "update") return changeHooks(o, (c, hash) => updateHook(c, a.args, hash));
  if (a.op === "remove") return changeHooks(o, (c, hash) => removeHook(c, a.id, hash));
  return changeHooks(o, (c, hash) => setHookOn(c, a.id, a.op === "on", hash));
}
