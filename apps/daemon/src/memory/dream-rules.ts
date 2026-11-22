import type { MemorySee, MemoryType } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { MemoryRow } from "../views/memory.js";
import type { MemoryFiles } from "./index.js";

/**
 * ion's dream (the user, 2026-11-22: "a 'dream' setting to allow active harness to manage stale information and
 * update memory"): the ion that tidies memory overnight. What it may never do, whatever it's told, is here; every
 * change it makes is a normal memory write by "ion (dream)", so History and Restore work.
 */
export const DREAM_ION = "dream";

const DAY_MS = 86_400_000;

/** A file the dream reads before it changes it: its path, type, who may see it, and whether it's a suggestion. */
type Touched = Pick<MemoryRow, "path" | "type" | "see"> & { suggested?: string | null };

/** You changed this file in the last day (in the app or an editor). */
function youChangedLately(memory: MemoryFiles, path: string, now = new Date()): boolean {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  return memory.history(path).some((c) => c.by === "you" && c.at > since);
}

/**
 * The dream never changes or forgets your person files (it may only say so in its summary), a chat's suggestion
 * (only you keep one), or a file you changed in the last day.
 */
export function dreamMayTouch(memory: MemoryFiles, f: Touched, now = new Date()): void {
  if (f.type === "person") throw new UserError("Your person files are the user's; say it in your summary");
  if (f.suggested) throw new UserError("A suggestion waits for the user to keep it");
  if (youChangedLately(memory, f.path, now))
    throw new UserError("The user changed this in the last day; leave it");
}

/** What a file the dream makes or retypes may be: never a person file or a to-do. */
export function dreamMayBe(type: MemoryType): void {
  if (type === "person") throw new UserError("Your person files are the user's; say it in your summary");
  if (type === "todo") throw new UserError("Only the user adds to-dos");
}

/** Who sees a file the dream makes: ions only (it never shares one with chats). */
export function dreamSee(see: MemorySee | undefined): MemorySee {
  if (see === "chats") throw new UserError("Only the user shares a file with chats");
  return "ions";
}

/** A file merged into another: into one the dream may change, seen by no more than the file it came from. */
export function dreamInto(from: Touched, into: Touched | undefined): void {
  if (!into) throw new UserError("Merge it into a file that's there");
  if (into.path === from.path) throw new UserError("Merge it into another file");
  // Into a person file or a suggestion would change one the dream may not (its write there was refused already).
  if (into.type === "person" || into.suggested) throw new UserError("Merge it into a file you may change");
  if (into.see === "chats" && from.see === "ions")
    throw new UserError("That shows it to chats; merge it into a file seen by ions only");
}
