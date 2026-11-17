import { isAbsolute, relative, resolve } from "node:path";
import type { ApprovalRequest } from "@ion/adapter-kit";

export type Verdict = { decision: "allow" | "deny"; reason: string };
export type RuleCtx = { roots: string[]; home: string; ionDirs: string[] };

/** Your secrets, under your home folder: never touched in Auto, whatever the judge would say. */
const SECRETS = [".ssh", ".aws", ".gnupg", ".config/gh", ".netrc", ".docker/config.json"];
/** Commands that only look: allowed in Auto when every path they name stays in the worktree. */
const READ_ONLY = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "pwd",
  "echo",
  "which",
  "sort",
  "uniq",
  "stat",
  "file",
]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame"]);
/** A path in any text: absolute, ~ or $HOME. */
const PATH = /(?:~|\$\{?HOME\}?)?\/[^\s'"`|;&<>()]+/g;

function* strings(v: unknown): Generator<string> {
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (v && typeof v === "object") for (const x of Object.values(v)) yield* strings(x);
}

const under = (p: string, dir: string) => {
  const rel = relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Every path the request mentions anywhere in its input, with ~ and $HOME expanded. */
function pathsIn(req: ApprovalRequest, home: string): string[] {
  const out: string[] = [];
  for (const s of strings(req.input))
    for (const m of s.matchAll(PATH)) out.push(resolve(m[0].replace(/^(~|\$\{?HOME\}?)/, home)));
  return out;
}

/** A read-only command (each part of a chain or pipe), with no redirects or subshells. */
function readOnly(command: string): boolean {
  if (/[>`]|\$\(/.test(command)) return false;
  return command.split(/&&|\|\||;|\|/).every((part) => {
    const [word, sub] = part.trim().split(/\s+/);
    return word === "git" ? READ_ONLY_GIT.has(sub ?? "") : READ_ONLY.has(word ?? "");
  });
}

/** The rules Auto applies before asking the judge; null means "ask the judge". */
export function ruleFor(req: ApprovalRequest, c: RuleCtx): Verdict | null {
  const paths = pathsIn(req, c.home);
  if (paths.some((p) => SECRETS.some((s) => under(p, resolve(c.home, s)))))
    return { decision: "deny", reason: "Touches your secrets" };
  const inWorktree = (p: string) => c.roots.some((r) => under(p, r));
  if (paths.some((p) => !inWorktree(p) && c.ionDirs.some((d) => under(p, d))))
    return { decision: "deny", reason: "Touches ion's own files" };
  const command = typeof req.input.command === "string" ? req.input.command : null;
  if (req.kind === "command" && command && readOnly(command) && paths.every(inWorktree))
    return { decision: "allow", reason: "Only looks inside the project" };
  return null;
}
