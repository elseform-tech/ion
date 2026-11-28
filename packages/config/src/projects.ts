import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { UserConfig } from "./user-config.js";

/** The project new chats use when none is picked. */
export const DEFAULT_PROJECT = "default";

/** Why a project name can't be used, or null when it can. */
export function projectNameError(name: string): string | null {
  if (RESERVED_IDS.includes(name)) return "That name is ion's own";
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ? null : "Use lowercase letters, numbers, - . _";
}

/** A project's id (and folder name) from the name you typed: "My App!" → "my-app". Empty when nothing usable. */
export function projectIdOf(name: string): string {
  let id = "";
  for (const ch of name.normalize("NFKD").toLowerCase()) {
    if (/[a-z0-9._]/.test(ch)) id += ch;
    else if (/\p{M}/u.test(ch))
      continue; // an accent, split off by NFKD: "é" → "e"
    else if (id && !id.endsWith("-")) id += "-";
  }
  while (id.endsWith("-") || id.endsWith(".")) id = id.slice(0, -1);
  while (id.startsWith(".") || id.startsWith("_")) id = id.slice(1);
  return id.slice(0, 64);
}

/**
 * Ids no project takes: ion chief's ("ion:chief" is its chat), and "you", your own memory's scope (task review,
 * 2026-11-22: a project called you shared it).
 */
export const RESERVED_IDS = ["chief", "you"];

/** Returns a new config with the git repo at `path` added. Throws a user-facing message otherwise. */
export function addProject(c: UserConfig, path: string): UserConfig {
  const abs = resolve(path);
  if (!existsSync(`${abs}/.git`)) throw new Error(`Not a git repository: ${path}`);
  const dup = c.projects.find((p) => p.path === abs);
  if (dup) throw new Error(`Already added: ${dup.id}`);
  // Its id a slug commands can take; the folder's own name kept to show (Plan 21 final review, M5).
  const folder = basename(abs);
  const base = projectIdOf(folder) || "project";
  const taken = new Set([...RESERVED_IDS, ...c.projects.map((p) => p.id)]);
  let id = base;
  let n = 1;
  while (taken.has(id)) id = `${base}-${++n}`;
  const named = folder !== base ? { name: folder.slice(0, 60) } : {};
  return { ...c, projects: [...c.projects, { id, path: abs, starred: false, ...named }] };
}

/** Shows a project under a new name; its id stays. Back to its id: the name is dropped. */
export function renameProject(c: UserConfig, id: string, name: string): UserConfig {
  if (id === DEFAULT_PROJECT) throw new Error("default can't be renamed");
  if (!c.projects.some((p) => p.id === id)) throw new Error(`Unknown project: ${id}`);
  const n = name.trim().slice(0, 60);
  if (!n) throw new Error("Give the project a name");
  const taken = c.projects.some(
    (p) => p.id !== id && [p.id, p.name].some((x) => x?.toLowerCase() === n.toLowerCase()),
  );
  if (taken || n.toLowerCase() === DEFAULT_PROJECT) throw new Error("That name is taken");
  return {
    ...c,
    projects: c.projects.map((p) => {
      if (p.id !== id) return p;
      const rest = { ...p };
      delete rest.name;
      return n === id ? rest : { ...rest, name: n };
    }),
  };
}

/** Takes a project out of ion. Its folder and repo are never touched. */
export function removeProject(c: UserConfig, id: string): UserConfig {
  if (id === DEFAULT_PROJECT) throw new Error("default can't be removed");
  if (!c.projects.some((p) => p.id === id)) throw new Error(`Unknown project: ${id}`);
  return { ...c, projects: c.projects.filter((p) => p.id !== id) };
}

/** Stars or unstars a project. */
export function setProjectStarred(c: UserConfig, id: string, starred: boolean): UserConfig {
  if (!c.projects.some((p) => p.id === id)) throw new Error(`Unknown project: ${id}`);
  return { ...c, projects: c.projects.map((p) => (p.id === id ? { ...p, starred } : p)) };
}
