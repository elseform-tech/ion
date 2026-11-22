import { isAbsolute, join, relative, resolve } from "node:path";
import type { ApprovalRequest } from "@ion/adapter-kit";
import { realish } from "../runs/policy.js";

/**
 * `plugin`: the run's own skills plugin folder (in ion's data folder), which it may read and run, never write.
 * `sandboxed`: the run is in the OS sandbox, which keeps ion's folders out of its reach (Plan 18 Task 12).
 */
export type RuleCtx = {
  roots: string[];
  home: string;
  ionDirs: string[];
  plugin?: string;
  sandboxed?: boolean;
  /** Auto (the user, 2026-11-21): reads anywhere but your secrets, ion's files and private kinds of files. */
  freeReads?: true;
};

/** A path in any text: absolute, ~ or $HOME, at the start of a word (not "/a.ts" inside "src/a.ts"). */
export const PATH = /(?<=^|[\s'"=:(])(?:~|\$\{?HOME\}?)?\/[^\s'"`|;&<>()]+/g;

export function* strings(v: unknown): Generator<string> {
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (v && typeof v === "object") for (const x of Object.values(v)) yield* strings(x);
}

export const under = (p: string, dir: string) => {
  const rel = relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
/** Where each XDG folder is when its variable isn't set. */
const XDG: Record<string, string> = {
  XDG_CONFIG_HOME: ".config",
  XDG_DATA_HOME: ".local/share",
  XDG_STATE_HOME: ".local/state",
  XDG_CACHE_HOME: ".cache",
};
export const expand = (p: string, home: string) => p.replace(/^(~|\$\{?HOME\}?)(?=\/|$)/, home);

/**
 * Text with each `$XDG_*_HOME/` filled in as the run's shell would fill it (its value, else where it is by default),
 * so a path through one is seen for what it is (Task review, 2026-11-21).
 */
export const fillXdg = (text: string, home: string) =>
  text.replace(
    /\$\{?(XDG_[A-Z]+_HOME)\}?(?=\/)/g,
    (_m, n: string) => process.env[n] || join(home, XDG[n] ?? n),
  );

/** Text as the shell reads it: escapes and quotes gone (`sec''urity`, `.con\fig`, `"ion"`). */
export const unshell = (s: string) => s.replace(/\\(.)/gs, "$1").replace(/["']/g, "");

// macOS folders ignore case by default: ~/.SSH is ~/.ssh.
// Names compare in one Unicode form (NFC; review of 05d5c8b, 2026-11-22: macOS takes "é" either way).
export const fold = (p: string) => {
  const n = p.normalize("NFC");
  return process.platform === "darwin" ? n.toLowerCase() : n;
};

/**
 * Every path the request names, resolved for real (symlinks followed): absolute and ~ paths anywhere in its input,
 * and a command's relative paths (from the worktree, where commands run). Read as the shell would: no quotes.
 */
export function pathsIn(req: ApprovalRequest, c: RuleCtx): string[] {
  const texts = [...strings(req.input)].flatMap((s) => [s, unshell(s)].map((t) => fillXdg(t, c.home)));
  const out = texts.flatMap((s) => [...s.matchAll(PATH)].map((m) => expand(m[0], c.home)));
  // Every argument of a command is a path from the worktree (where commands run): a link named "key" counts too.
  // A command given as a list of words (Codex's shell) too (task review, 2026-11-22).
  const command = unshell(commandText(req));
  const words = command.split(/[\s|;&]+/).filter((t) => t && !/^[-/~$]/.test(t));
  out.push(...words.map((t) => resolve(c.roots[0] ?? "/", t)));
  return out.map((p) => realish(resolve(p)));
}

/**
 * Every string in a tool's input, anywhere and whatever its field is called, taken as a path from the worktree
 * (links followed): a word ("tip") stays inside; a path through a link out of the worktree doesn't.
 */
export function toolPaths(req: ApprovalRequest, c: RuleCtx): string[] {
  return [...strings(req.input)]
    .filter((v) => !/^[/~$]/.test(v))
    .map((v) => realish(resolve(c.roots[0] ?? "/", v)));
}

/**
 * What a search looks for: text matched in files, not a path. A glob tool's `pattern` is a path, though (as in
 * runs/policy.ts).
 */
const CONTENT = new Set(["pattern", "query", "regex", "search", "text"]);
export const isContent = (req: ApprovalRequest, k: string) =>
  CONTENT.has(k) && !(k === "pattern" && /glob/i.test(req.toolName));

/** What a tool writes or searches for, not where: a file's new text names paths without touching them. */
const WRITTEN = new Set([
  "content",
  "new_string",
  "old_string",
  "edits",
  "new_source",
  "text",
  "description",
  "prompt",
]);
export const withoutText = (req: ApprovalRequest): ApprovalRequest => ({
  ...req,
  input: Object.fromEntries(Object.entries(req.input).filter(([k]) => !WRITTEN.has(k) && !isContent(req, k))),
});

/** A command as text: a shell string, or argv (a list of words) joined. */
export function commandText(req: ApprovalRequest): string {
  const c = req.input.command;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.filter((w): w is string => typeof w === "string").join(" ") : "";
}
