import type { MemoryScope, MemorySee, MemoryType } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { MemoryRow } from "../views/memory.js";
import type { MemoryFiles } from "./index.js";

/**
 * ion's dream (the user, 2026-11-22: "a 'dream' setting to allow active harness to manage stale information and
 * update memory"): the ion that tidies memory overnight. What it may never do, whatever it's told, is here; every
 * change it makes is a normal memory write by "ion (dream)", so History and Restore work.
 */
/** Its id: one no project can have (a project's id starts with a letter or digit). */
export const DREAM_ION = "_dream";

const DAY_MS = 86_400_000;

/** A file the dream reads before it changes it: its path, type, who may see it, and whether it's a suggestion. */
type Touched = Pick<MemoryRow, "path" | "type" | "see"> & { suggested?: string | null };

/** You changed this file in the last day (in the app or an editor). */
function youChangedLately(memory: MemoryFiles, path: string, now = new Date()): boolean {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  return memory.history(path).some((c) => c.by === "you" && c.at > since);
}

/**
 * The dream never changes or forgets your person files or to-dos (it may only say so in its summary), a chat's
 * suggestion (only you keep one), or a file you changed in the last day.
 */
function dreamMayTouch(memory: MemoryFiles, f: Touched, now = new Date()): void {
  if (f.type === "person") throw new UserError("Your person files are the user's; say it in your summary");
  // Not even a to-do's text (task review, 2026-11-22): it may only note one in its summary.
  if (f.type === "todo") throw new UserError("A to-do is yours; I'll note it");
  if (f.suggested) throw new UserError("A suggestion waits for the user to keep it");
  if (youChangedLately(memory, f.path, now))
    throw new UserError("The user changed this in the last day; leave it");
}

/** What a file the dream makes or retypes may be: never a person file or a to-do. */
function dreamMayBe(type: MemoryType): void {
  if (type === "person") throw new UserError("Your person files are the user's; say it in your summary");
  if (type === "todo") throw new UserError("Only the user adds to-dos");
}

/**
 * A dream's pass (task review, 2026-11-22: ions-only text must never reach a file chats see, and no pass mixes two
 * projects): each keeps to one project's files (`project`; yours are context) or to yours (null), and changes only
 * files seen as `see` says.
 */
export type DreamPass = { see: MemorySee; project?: string | null };

/** The pass may change a file seen like this, in this scope. */
function passWrites(pass: DreamPass, scope: MemoryScope, see: MemorySee): void {
  if (see !== pass.see)
    throw new UserError(
      pass.see === "ions"
        ? "This pass only changes files chats can't see"
        : "This pass only changes files chats see",
    );
  const mine = pass.project ? scope !== "you" && scope.projectId === pass.project : scope === "you";
  const whose = pass.project ? `${pass.project}'s` : "your";
  if (!mine) throw new UserError(`This pass only changes ${whose} files`);
}

/** A file the dream makes: never a person file or a to-do, seen as its pass's files are. */
export function dreamCreate(
  pass: DreamPass,
  scope: MemoryScope,
  type: MemoryType,
  see?: MemorySee,
): MemorySee {
  dreamMayBe(type);
  if (see && see !== pass.see) throw new UserError("I never change who sees a file");
  passWrites(pass, scope, pass.see);
  return pass.see;
}

/** A file the dream updates: one it may touch and its pass may change, never retyped to a person file or to-do. */
export function dreamUpdate(
  memory: MemoryFiles,
  pass: DreamPass,
  was: Touched & { scope: MemoryScope },
  next: { type: MemoryType; see: MemorySee },
): void {
  dreamMayTouch(memory, was);
  if (next.see !== was.see) throw new UserError("I never change who sees a file");
  passWrites(pass, was.scope, was.see);
  if (next.type !== was.type) dreamMayBe(next.type);
}

/** A file the dream forgets, and the file it was merged into (one it may touch and its pass may change). */
export function dreamForget(
  memory: MemoryFiles,
  pass: DreamPass,
  from: Touched & { scope: MemoryScope },
  into?: Touched & { scope: MemoryScope },
): void {
  dreamMayTouch(memory, from);
  passWrites(pass, from.scope, from.see);
  if (!into) return;
  if (into.path === from.path) throw new UserError("Merge it into another file");
  dreamMayTouch(memory, into);
  passWrites(pass, into.scope, into.see);
}
