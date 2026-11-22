import { statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ApprovalRequest } from "@ion/adapter-kit";
import { realish } from "../runs/policy.js";
import { hardRuleFor } from "./hard.js";
import { isSecret, SECRET_NAMES } from "./secrets.js";
import { touchesKeychain } from "./keychain.js";
import { commandText, fold, isContent, pathsIn, type RuleCtx, strings, toolPaths, under } from "./paths.js";

export type Verdict = { decision: "allow" | "deny"; reason: string };
export type { RuleCtx } from "./paths.js";

/** Commands that only look: allowed in Auto when every path they name is free to read. */
const READ_ONLY = new Set(["ls", "cat", "head", "tail", "wc", "grep", "pwd", "echo", "which", "stat"]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame"]);
/** A plain relative path or word: no absolute or home paths, no shell syntax. */
const PLAIN = /^[\w.\-/@+=:,%]+$/;
/** A plain path from your home (`~/notes/a.md`), for Auto's free reads. */
const HOME_PATH = /^~\/[\w.\-/@+=:,%]+$/;
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
    const plain = (t: string) =>
      (PLAIN.test(t) && (anywhere || !t.startsWith("/")) && !t.startsWith("-")) ||
      (anywhere && HOME_PATH.test(t));
    if (!args.every((t) => FLAG.test(t) || plain(t))) return false;
    if (word === "tail" && /\s(-[a-zA-Z]*[fF]|--follow)/.test(part)) return false;
    return word === "git"
      ? READ_ONLY_GIT.has(sub ?? "") && !/--output|--ext-diff/.test(part)
      : READ_ONLY.has(word ?? "");
  });
}

/** A flag that makes `ls` or `grep` read folders whole (`-R`, `-r`, `--recursive`). */
const RECURSIVE_FLAG = /^(-[a-zA-Z]*[rR]|--(dereference-)?recursive$)/;
/** A read-only command that reads folders whole (`ls -R`, `grep -r`): from outside the project, the judge decides. */
const recurses = (command: string) =>
  command.split(/&&|\|\||;|\|/).some((part) => {
    const [word, ...rest] = part.trim().split(/\s+/);
    return (word === "ls" || word === "grep") && rest.some((t) => RECURSIVE_FLAG.test(t));
  });

/** Private folders on your computer: outside the project, reading them is for the judge (security review, 2026-11-21). */
const PRIVATE_FOLDERS = ["/proc", "/sys", "/dev", "/private/var/db", "/var/db"];
const PRIVATE_LIBRARY = [
  "Application Support",
  "Keychains",
  "Cookies",
  "Containers",
  "Group Containers",
  "Mail",
  "Messages",
  "Safari",
  // Task review, 2026-11-22.
  "Preferences",
  "Accounts",
  "Calendars",
  "Mobile Documents",
  "Logs",
  "IdentityServices",
];
/** Private kinds of files, by name: keys, certificates, vaults, credentials, secrets, .env files. */
const PRIVATE_NAME = /^\.env|\.(pem|key|p12|kdbx)$|credential|secret|^id_/i;

/** Under a dot-folder or a dotfile itself (`~/.config/…`, `~/.zsh_history`, `.git/…`, `.env`). */
const dotted = (p: string) => p.split("/").some((s) => s.startsWith(".") && s !== "." && s !== "..");
/** A folder named secret(s), private or credentials on the way (macOS's own leading /private aside). */
const PRIVATE_SEGMENT = /^(secrets?|private|credentials)$/i;
const privateSegment = (p: string) =>
  p
    .replace(/^\/private(?=\/)/, "")
    .split("/")
    .slice(0, -1)
    .some((s) => PRIVATE_SEGMENT.test(s));

/**
 * Free to read in Auto, outside the project (security review, 2026-11-21: by class, not a few names): not a secret
 * (refused before), not under a dot-folder or a dotfile, not a private folder of your computer or your Library, not a
 * private kind of file. Other repos, ~/Downloads, ~/Documents, /usr and /etc/hosts stay free.
 */
function readable(p: string, c: RuleCtx): boolean {
  const f = fold(p);
  const library = PRIVATE_LIBRARY.map((d) => fold(realish(join(c.home, "Library", d))));
  const folders = [...PRIVATE_FOLDERS.map((d) => fold(d)), ...library];
  return (
    !isSecret(p, c.home) &&
    !dotted(p) &&
    !privateSegment(p) &&
    !PRIVATE_NAME.test(basename(p)) &&
    !folders.some((d) => under(f, d))
  );
}

/** An existing regular file (links followed), not a folder or a device. */
function regularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Auto's free reads (the user, 2026-11-21): a read tool, or a read-only command, whose every path is free to read; a
 * search from outside the project and a recursive command outside it go to the judge.
 */
function readsFreely(req: ApprovalRequest, c: RuleCtx, outside: string[]): boolean {
  if (!c.freeReads || !outside.every((p) => readable(p, c))) return false;
  const command = commandText(req);
  // A command reads outside freely only regular files: a folder goes to the judge, whatever its flags say.
  if (req.kind === "command")
    return readOnly(command, true) && outside.every(regularFile) && !recurses(command);
  // A read tool on a folder (or on nothing) outside goes to the judge too (task review, 2026-11-22).
  return req.kind === "read" && !climbs(req) && outside.every(regularFile);
}

/** Only looks: inside the worktree (read-only commands, reads and searches), or anywhere free to read in Auto. */
function looks(req: ApprovalRequest, c: RuleCtx, paths: string[]): Verdict | null {
  const inWorktree = (p: string) => c.roots.some((r) => under(p, realish(r)));
  const command = typeof req.input.command === "string" ? req.input.command : null;
  if (req.kind === "command" && command && readOnly(command) && paths.every(inWorktree))
    return { decision: "allow", reason: "Only looks inside the project" };
  // A read or search tool (not a shell) names its paths as they are: inside the worktree, it only looks.
  // A tool's absolute paths whole, spaces and all (`~/Library/Application Support/…`).
  const whole = pathStrings(req)
    .filter((v) => v.startsWith("/"))
    .map((v) => realish(resolve(v)));
  const named = req.kind === "command" ? paths : [...paths, ...whole, ...toolPaths(req, c)];
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
