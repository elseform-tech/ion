import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { UserConfig } from "./user-config.js";

/** The project new chats use when none is picked. */
export const DEFAULT_PROJECT = "default";

/** Why a project name can't be used, or null when it can. */
export function projectNameError(name: string): string | null {
  if (name === ION_CHIEF) return "That name is ion's own";
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ? null : "Use lowercase letters, numbers, - . _";
}

/** ion chief's own id: no project takes it (its chat is "ion:chief"). */
const ION_CHIEF = "chief";

/** Returns a new config with the git repo at `path` added. Throws a user-facing message otherwise. */
export function addProject(c: UserConfig, path: string): UserConfig {
  const abs = resolve(path);
  if (!existsSync(`${abs}/.git`)) throw new Error(`Not a git repository: ${path}`);
  const dup = c.projects.find((p) => p.path === abs);
  if (dup) throw new Error(`Already added: ${dup.id}`);
  const base = basename(abs);
  const taken = new Set([ION_CHIEF, ...c.projects.map((p) => p.id)]);
  let id = base;
  let n = 1;
  while (taken.has(id)) id = `${base}-${++n}`;
  return { ...c, projects: [...c.projects, { id, path: abs, starred: false }] };
}

/** Stars or unstars a project. */
export function setProjectStarred(c: UserConfig, id: string, starred: boolean): UserConfig {
  if (!c.projects.some((p) => p.id === id)) throw new Error(`Unknown project: ${id}`);
  return { ...c, projects: c.projects.map((p) => (p.id === id ? { ...p, starred } : p)) };
}

/** Sets a project's access mode ("auto" or "full"). */
export function setProjectAccess(c: UserConfig, id: string, access: "auto" | "full"): UserConfig {
  if (!c.projects.some((p) => p.id === id)) throw new Error(`Unknown project: ${id}`);
  return { ...c, projects: c.projects.map((p) => (p.id === id ? { ...p, access } : p)) };
}
