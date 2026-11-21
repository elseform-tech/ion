import type { ApprovalRequest } from "@ion/adapter-kit";
import { realish } from "../runs/policy.js";
import { commandParts, programsOf } from "./scripts.js";
import { commandText, fold, pathsIn, type RuleCtx, toolPaths, under, unshell, withoutText } from "./paths.js";

/** Programs that only read a file, or run a script they're given. */
const READERS = new Set(["cat", "head", "tail", "less", "more", "wc", "ls", "file", "stat", "grep", "diff"]);
const RUNNERS = new Set(["python", "python3", "node", "bash", "sh", "zsh", "ruby", "perl", "deno", "bun"]);
/** A runner's flags that run code from the command line or edit in place (`-c`, `-e`, `-i`, `--eval`). */
const INLINE_LONG = new Set(["--eval", "--print", "--in-place", "--command"]);
const inline = (w: string) =>
  w.startsWith("--")
    ? INLINE_LONG.has(w.split("=")[0]!)
    : /^-[A-Za-z0-9]+$/.test(w) && /[cei]/.test(w.slice(1));

/** The run's own skills plugin folder, as the filesystem compares it; null when the run has none. */
const pluginOf = (c: RuleCtx) => (c.plugin ? fold(realish(c.plugin)) : null);

/** A path inside the run's own skills plugin (never another run's: only exactly this run's folder). */
export const inPlugin = (p: string, c: RuleCtx): boolean => {
  const dir = pluginOf(c);
  return dir !== null && under(fold(p), dir);
};

/** One command of a chain: every program reads or runs a script (or is a script in the plugin), none inline. */
function readsOrRunsPart(words: string[], c: RuleCtx): boolean {
  const progs = programsOf(words);
  return (
    progs.length > 0 &&
    progs.every((p) => {
      const w = words[p.at]!;
      if (w.startsWith("/") && inPlugin(realish(w), c)) return true;
      if (READERS.has(p.name)) return true;
      return RUNNERS.has(p.name) && !words.slice(p.at + 1).some(inline);
    })
  );
}

/**
 * Whether a call only reads or runs files (a read or search tool; a command of readers and script runners with no
 * redirect, substitution or inline code), so the run's own skills plugin may be named in it. Writes never are.
 */
export function readsOrRuns(req: ApprovalRequest, c: RuleCtx): boolean {
  if (!c.plugin) return false;
  if (req.kind === "read" || req.kind === "search") return true;
  if (req.kind !== "command") return false;
  const command = commandText(req);
  if (/[<>`]|\$\(/.test(unshell(command)) || /[<>`]|\$\(/.test(command)) return false;
  return commandParts(command).every((w) => readsOrRunsPart(w, c));
}

/**
 * A read or search of files only in the run's own skills plugin (or the worktree): allowed like the worktree, in
 * every access mode. A command that runs a skill's script goes the usual way (Full, or Auto's judge).
 */
export function onlyPlugin(req0: ApprovalRequest, c: RuleCtx): boolean {
  if (!c.plugin || (req0.kind !== "read" && req0.kind !== "search")) return false;
  const req = withoutText(req0);
  const paths = [...pathsIn(req, c), ...toolPaths(req, c)];
  const roots = c.roots.map((r) => fold(realish(r)));
  const inside = (p: string) => roots.some((r) => under(fold(p), r));
  return paths.some((p) => inPlugin(p, c)) && paths.every((p) => inPlugin(p, c) || inside(p));
}
