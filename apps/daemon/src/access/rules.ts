import { join } from "node:path";
import type { ApprovalRequest } from "@ion/adapter-kit";
import { realish } from "../runs/policy.js";
import { agentConfigs } from "../runs/sandbox.js";
import { hardRuleFor } from "./hard.js";
import { touchesKeychain } from "./keychain.js";
import { commandText, fold, isContent, pathsIn, type RuleCtx, strings, toolPaths, under } from "./paths.js";

export type Verdict = { decision: "allow" | "deny"; reason: string };
export type { RuleCtx } from "./paths.js";

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
/** Commands that only look: allowed in Auto when every path they name is free to read. */
const READ_ONLY = new Set(["ls", "cat", "head", "tail", "wc", "grep", "pwd", "echo", "which", "stat"]);
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
/**
 * A read-only command the rule can fully read: a plain chain or pipe of read-only commands, nothing else. `anywhere`:
 * absolute paths may be named too (Auto's free reads); "~" and ".." still go to the judge.
 */
function readOnly(command: string, anywhere = false): boolean {
  // Anything the shell would expand or unquote (globs, quotes, escapes) is left to the judge.
  if (/[\n\r<>`$(){}*?[\]'"\\]/.test(command) || /(^|[^&])&([^&]|$)/.test(command) || command.includes(".."))
    return false;
  return command.split(/&&|\|\||;|\|/).every((part) => {
    const [word, sub, ...rest] = part.trim().split(/\s+/);
    // Every argument is a flag or a plain relative path ("/", "~" and the like go to the judge).
    const args = word === "git" ? rest : [sub, ...rest].filter((x): x is string => x !== undefined);
    const plain = (t: string) => PLAIN.test(t) && (anywhere || !t.startsWith("/")) && !t.startsWith("-");
    if (!args.every((t) => FLAG.test(t) || plain(t))) return false;
    if (word === "tail" && /\s(-[a-zA-Z]*[fF]|--follow)/.test(part)) return false;
    return word === "git"
      ? READ_ONLY_GIT.has(sub ?? "") && !/--output|--ext-diff/.test(part)
      : READ_ONLY.has(word ?? "");
  });
}

const isSecret = (p: string, home: string) =>
  SECRETS.some((s) => {
    const secret = fold(realish(join(home, s)));
    return s.endsWith("/") ? under(fold(p), secret) : fold(p) === secret;
  });
/** A flag that makes `ls` or `grep` read folders whole (`-R`, `-r`, `--recursive`). */
const RECURSIVE_FLAG = /^(-[a-zA-Z]*[rR]|--(dereference-)?recursive$)/;
/** A read-only command that reads folders whole (`ls -R`, `grep -r`): from outside the project, the judge decides. */
const recurses = (command: string) =>
  command.split(/&&|\|\||;|\|/).some((part) => {
    const [word, ...rest] = part.trim().split(/\s+/);
    return (word === "ls" || word === "grep") && rest.some((t) => RECURSIVE_FLAG.test(t));
  });

/** Every agent's settings but the run's own (they hold your provider settings and keys). */
const othersSettings = (c: RuleCtx) =>
  agentConfigs(c.agent ?? "", { ...process.env, HOME: c.home }).map((d) => fold(realish(d)));

/** Free to read in Auto: not a secret, not another agent's settings (ion's own files are the hard rules'). */
const readable = (p: string, c: RuleCtx) =>
  !isSecret(p, c.home) && !othersSettings(c).some((d) => under(fold(p), d));

/** A folder a search would sweep that holds your secrets or another agent's settings. */
const sweeps = (p: string, c: RuleCtx) =>
  [...SECRETS.map((s) => fold(realish(join(c.home, s)))), ...othersSettings(c)].some((s) =>
    under(s, fold(p)),
  );

/**
 * Auto's free reads (the user, 2026-11-21): a read or search tool, or a read-only command, whose every path is free to
 * read; a search never of a folder holding secrets, a command never recursive outside the project.
 */
function readsFreely(req: ApprovalRequest, c: RuleCtx, outside: string[]): boolean {
  if (!c.freeReads || !outside.every((p) => readable(p, c))) return false;
  const command = commandText(req);
  if (req.kind === "command") return readOnly(command, true) && !(outside.length > 0 && recurses(command));
  if (req.kind === "search" && outside.some((p) => sweeps(p, c))) return false;
  return (req.kind === "read" || req.kind === "search") && !climbs(req);
}

/** Only looks: inside the worktree (read-only commands, reads and searches), or anywhere free to read in Auto. */
function looks(req: ApprovalRequest, c: RuleCtx, paths: string[]): Verdict | null {
  const inWorktree = (p: string) => c.roots.some((r) => under(p, realish(r)));
  const command = typeof req.input.command === "string" ? req.input.command : null;
  if (req.kind === "command" && command && readOnly(command) && paths.every(inWorktree))
    return { decision: "allow", reason: "Only looks inside the project" };
  // A read or search tool (not a shell) names its paths as they are: inside the worktree, it only looks.
  const named = req.kind === "command" ? paths : [...paths, ...toolPaths(req, c)];
  if ((req.kind === "read" || req.kind === "search") && !climbs(req) && named.every(inWorktree))
    return { decision: "allow", reason: "Only looks inside the project" };
  const outside = named.filter((p) => !inWorktree(p));
  return readsFreely(req, c, outside) ? { decision: "allow", reason: "Only reads" } : null;
}

const namesSecret = (req: ApprovalRequest) =>
  [...strings(req.input)].some((v) => SECRET_NAMES.some((n) => v.toLowerCase().includes(n)));

/** The rules Auto applies before asking the judge; null means "ask the judge". */
export function ruleFor(req: ApprovalRequest, c: RuleCtx): Verdict | null {
  const paths = pathsIn(req, c);
  if (namesSecret(req) || touchesKeychain(req, c) || paths.some((p) => isSecret(p, c.home)))
    return { decision: "deny", reason: "Touches your secrets" };
  const hard = hardRuleFor(req, c);
  // A guess of ion's isn't a rule's no (the user, 2026-11-21): it goes on to the judge.
  if (hard) return hard.wary ? null : hard;
  return looks(req, c, paths);
}

/** Every string of a tool's input that can name a path: all but what it searches for, however deep. */
const pathStrings = (req: ApprovalRequest) =>
  Object.entries(req.input).flatMap(([k, v]) => (isContent(req, k) ? [] : [...strings(v)]));

/**
 * Input the rule can't fully read, left to the judge: in any string, "..", a glob's braces (they can hide a climb
 * or an absolute path) or a start at your home ("~", $HOME); in a path, wildcards too (they can match through a
 * link out of the worktree). What a search looks for keeps its wildcards.
 */
const climbs = (req: ApprovalRequest) =>
  [...strings(req.input)].some(
    (v) => v.includes("..") || /[{}]/.test(v) || v.startsWith("~") || /\$\{?HOME/.test(v),
  ) || pathStrings(req).some((v) => /[*?[\]]/.test(v));
