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
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame"]);
/** Secret folders and files named anywhere in an action (any case) are denied: they never belong to a project. */
const SECRET_NAMES = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".password-store",
  "keychains",
  ".config/gh",
  ".config/gcloud",
  ".config/op",
  ".docker/config",
  ".git-credentials",
  ".netrc",
  ".pypirc",
];
/** A plain relative path or word: no absolute or home paths, no shell syntax. */
const PLAIN = /^[\w.\-/@+=:,%]+$/;
/** A plain flag ("-n5", "--count"): no "=value" or path tucked into it. */
const FLAG = /^--?[\w-]+$/;
/** A path in any text: absolute, ~ or $HOME, at the start of a word (not "/a.ts" inside "src/a.ts"). */
const PATH = /(?<=^|[\s'"=:(])(?:~|\$\{?HOME\}?)?\/[^\s'"`|;&<>()]+/g;

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
  // Every argument of a command is a path from the worktree (where commands run): a link named "key" counts too.
  const command = typeof req.input.command === "string" ? req.input.command : "";
  for (const t of command.split(/[\s|;&]+/))
    if (t && !t.startsWith("-") && !t.startsWith("/") && !/^[~$]/.test(t))
      out.push(resolve(c.roots[0] ?? "/", t));
  return out.map((p) => realish(resolve(p)));
}

/** A read-only command the rule can fully read: a plain chain or pipe of read-only commands, nothing else. */
function readOnly(command: string): boolean {
  // Anything the shell would expand or unquote (globs, quotes, escapes) is left to the judge.
  if (/[\n\r<>`$(){}*?[\]'"\\]/.test(command) || /(^|[^&])&([^&]|$)/.test(command) || command.includes(".."))
    return false;
  return command.split(/&&|\|\||;|\|/).every((part) => {
    const [word, sub, ...rest] = part.trim().split(/\s+/);
    // Every argument is a flag or a plain relative path ("/", "~" and the like go to the judge).
    const args = word === "git" ? rest : [sub, ...rest].filter((x): x is string => x !== undefined);
    if (!args.every((t) => FLAG.test(t) || (PLAIN.test(t) && !t.startsWith("/") && !t.startsWith("-"))))
      return false;
    if (word === "tail" && /\s(-[a-zA-Z]*[fF]|--follow)/.test(part)) return false;
    return word === "git"
      ? READ_ONLY_GIT.has(sub ?? "") && !/--output|--ext-diff/.test(part)
      : READ_ONLY.has(word ?? "");
  });
}

// macOS folders ignore case by default: ~/.SSH is ~/.ssh.
const fold = (p: string) => (process.platform === "darwin" ? p.toLowerCase() : p);
const isSecret = (p: string, home: string) =>
  SECRETS.some((s) => {
    const secret = fold(realish(join(home, s)));
    return s.endsWith("/") ? under(fold(p), secret) : fold(p) === secret;
  });
const namesSecret = (req: ApprovalRequest) =>
  [...strings(req.input)].some((v) => SECRET_NAMES.some((n) => v.toLowerCase().includes(n)));

/** Grok's folders (yours, where ion's gate hook lives, and a worktree's): `.grok` named, or a path into one. */
const ION_HOOK = /(^|[\s'"=/])\.grok(\/hooks(\/|$|[\s'";|&)])|\/?(?=$|[\s'";|&)]))/i;
const touchesHook = (req: ApprovalRequest, paths: string[], c: RuleCtx) =>
  [...strings(req.input)].some((v) => ION_HOOK.test(v)) ||
  paths.some((p) => [...c.roots, c.home].some((r) => under(fold(p), fold(join(realish(r), ".grok")))));

/** The rules Auto applies before asking the judge; null means "ask the judge". */
export function ruleFor(req: ApprovalRequest, c: RuleCtx): Verdict | null {
  const paths = pathsIn(req, c);
  if (namesSecret(req) || paths.some((p) => isSecret(p, c.home)))
    return { decision: "deny", reason: "Touches your secrets" };
  const inWorktree = (p: string) => c.roots.some((r) => under(p, realish(r)));
  if (
    touchesHook(req, paths, c) ||
    paths.some((p) => !inWorktree(p) && c.ionDirs.some((d) => under(p, realish(d))))
  )
    return { decision: "deny", reason: "Touches ion's own files" };
  const command = typeof req.input.command === "string" ? req.input.command : null;
  if (req.kind === "command" && command && readOnly(command) && paths.every(inWorktree))
    return { decision: "allow", reason: "Only looks inside the project" };
  return null;
}
