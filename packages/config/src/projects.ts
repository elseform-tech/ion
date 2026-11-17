import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { UserConfig } from "./user-config.js";

/** Returns a new config with the git repo at `path` added. Throws a user-facing message otherwise. */
export function addProject(c: UserConfig, path: string): UserConfig {
  const abs = resolve(path);
  if (!existsSync(`${abs}/.git`)) throw new Error(`Not a git repository: ${path}`);
  const dup = c.projects.find((p) => p.path === abs);
  if (dup) throw new Error(`Already added: ${dup.id}`);
  const base = basename(abs);
  const taken = new Set(c.projects.map((p) => p.id));
  let id = base;
  let n = 1;
  while (taken.has(id)) id = `${base}-${++n}`;
  return { ...c, projects: [...c.projects, { id, path: abs, starred: false }] };
}
