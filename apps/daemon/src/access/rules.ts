import { isAbsolute, join, relative, resolve } from "node:path";
import type { ApprovalRequest } from "@ion/adapter-kit";
import { realish } from "../runs/policy.js";

export type Verdict = { decision: "allow" | "deny"; reason: string };
export type RuleCtx = { roots: string[]; home: string; ionDirs: string[] };

/** Your secrets under your home folder (folders end in "/"): never touched in Auto, whatever the judge says. */
const SECRETS = [
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".kube/",
  ".docker/",
  ".config/gh/",
  ".config/gcloud/",
  ".config/op/",
  ".password-store/",
  "Library/Keychains/",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
];
/** Commands that only look: allowed in Auto when every path they name stays in the worktree. */
const READ_ONLY = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "pwd",
  "echo",
  "which",
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
const expand = (p: string, home: string) => p.replace(/^(~|\$\{?HOME\}?)/, home);

/**
 * Every path the request names, resolved for real (symlinks followed): absolute and ~ paths anywhere in its input,
 * and a command's relative paths (from the worktree, where commands run).
 */
function pathsIn(req: ApprovalRequest, c: RuleCtx): string[] {
  const out: string[] = [];
  for (const s of strings(req.input)) for (const m of s.matchAll(PATH)) out.push(expand(m[0], c.home));
  const command = typeof req.input.command === "string" ? req.input.command : "";
  for (const t of command.split(/[\s|;&]+/))
    if (
      t &&
      !t.startsWith("-") &&
      !t.startsWith("/") &&
      !/^[~$]/.test(t) &&
      (t.includes("/") || t.startsWith("."))
    )
      out.push(resolve(c.roots[0] ?? "/", t));
  return out.map((p) => realish(resolve(p)));
}

/** A read-only command the rule can fully read: a plain chain or pipe of read-only commands, nothing else. */
function readOnly(command: string): boolean {
  if (/[\n\r<>`$(){}]/.test(command) || /(^|[^&])&([^&]|$)/.test(command) || command.includes(".."))
    return false;
  return command.split(/&&|\|\||;|\|/).every((part) => {
    const [word, sub] = part.trim().split(/\s+/);
    return word === "git"
      ? READ_ONLY_GIT.has(sub ?? "") && !/--output|--ext-diff/.test(part)
      : READ_ONLY.has(word ?? "");
  });
}

const isSecret = (p: string, home: string) =>
  SECRETS.some((s) => (s.endsWith("/") ? under(p, realish(join(home, s))) : p === realish(join(home, s))));

/** The rules Auto applies before asking the judge; null means "ask the judge". */
export function ruleFor(req: ApprovalRequest, c: RuleCtx): Verdict | null {
  const paths = pathsIn(req, c);
  if (paths.some((p) => isSecret(p, c.home))) return { decision: "deny", reason: "Touches your secrets" };
  const inWorktree = (p: string) => c.roots.some((r) => under(p, realish(r)));
  if (paths.some((p) => !inWorktree(p) && c.ionDirs.some((d) => under(p, realish(d)))))
    return { decision: "deny", reason: "Touches ion's own files" };
  const command = typeof req.input.command === "string" ? req.input.command : null;
  if (req.kind === "command" && command && readOnly(command) && paths.every(inWorktree))
    return { decision: "allow", reason: "Only looks inside the project" };
  return null;
}
