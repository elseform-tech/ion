import type { HookEntry } from "@ion/config";
import { AUTO_APPROVAL, HOOK_EVENTS, type HookEvent } from "@ion/schema";
import { type Sign, sameMark } from "../secrets/consent-key.js";
import { CANT_READ_KEYCHAIN } from "../secrets/index.js";

type Consentable = Pick<HookEntry, "id" | "name" | "run" | "event" | "project">;
/** A hook's consent mark (keyed with ion's own secret), when it could be made. */
export type HookHash = (h: Consentable) => string | undefined;

/**
 * What you consent to when you turn a hook on: which hook, its name (ion shows it), what it runs, when, and for which
 * project.
 */
const material = (h: Consentable) =>
  `hook:${JSON.stringify([h.id, h.name, h.run, h.event, h.project ?? null])}`;

/** Each of these hooks' consent marks, signed with this install's key (one that can't be signed has none). */
export async function hookHasher(sign: Sign, hooks: Consentable[]): Promise<HookHash> {
  const pairs = await Promise.all(
    hooks.map(async (h) => [material(h), await sign(material(h)).catch(() => undefined)] as const),
  );
  const marks = new Map(pairs);
  return (h) => marks.get(material(h));
}

/** The hooks you turned on, by id: what each ran then ("<id>@<consent mark>" in your config). */
const turnedOn = (hooksOn: string[]) =>
  new Map(hooksOn.map((e) => [e.slice(0, e.lastIndexOf("@")), e.slice(e.lastIndexOf("@") + 1)]));

/**
 * Whether a hook runs: on, and turned on in the app for exactly what it runs now (its record verifies with ion's
 * key). One with no record is off: new if it says on (added, or set on, by hand), else one you turned off. One
 * changed by hand since, or with a record ion didn't sign, is changed. `unverified`: it has a record ion couldn't
 * check (the keychain can't be read).
 */
export function consentOf(
  h: HookEntry,
  hooksOn: string[],
  hash: HookHash,
): { on: boolean; new?: true; changed?: true; unverified?: true } {
  const was = turnedOn(hooksOn).get(h.id);
  if (was === undefined) return h.on ? { on: false, new: true } : { on: false };
  const now = hash(h);
  if (!now) return { on: false, unverified: true };
  if (!sameMark(was, now)) return { on: false, changed: true };
  return { on: h.on };
}

/** Your consent list with this hook as it is now (on) or without it (off). */
export function withConsent(hooksOn: string[], h: HookEntry, on: boolean, hash: HookHash): string[] {
  const kept = hooksOn.filter((e) => e.slice(0, e.lastIndexOf("@")) !== h.id);
  if (!on) return kept;
  const mark = hash(h);
  if (!mark) throw new Error(CANT_READ_KEYCHAIN);
  return [...kept, `${h.id}@${mark}`];
}

/** Hooks left out, said once in the daemon's log. */
const warned = new Set<string>();

/**
 * Your hooks ion can use: one on an event ion doesn't know, or with Auto-approval's id (ion's own), is left out,
 * said once.
 */
export function usableHooks(hooks: HookEntry[]): HookEntry[] {
  const why = (h: HookEntry) => {
    if (h.id === AUTO_APPROVAL) return "that id is Auto-approval's";
    return HOOK_EVENTS.includes(h.event as HookEvent) ? null : "not an ion event";
  };
  for (const h of hooks) {
    const w = why(h);
    if (!w || warned.has(`${h.id}:${w}`)) continue;
    warned.add(`${h.id}:${w}`);
    console.warn(`config: hook ${h.id} left out: ${w}`);
  }
  return hooks.filter((h) => !why(h));
}
