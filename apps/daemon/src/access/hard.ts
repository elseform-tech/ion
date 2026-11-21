import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ApprovalRequest } from "@ion/adapter-kit";
import { realish } from "../runs/policy.js";
import { ionFolders } from "../runs/sandbox.js";
import { printsEnvironment } from "./env-dump.js";
import { inPlugin, readsOrRuns } from "./plugin.js";
import { touchesKeychain } from "./keychain.js";
import { commandParts, programsOf, readStart, scriptsIn } from "./scripts.js";
import { dropsRunKey, NAMES_RUN_VAR, namesIonHome, runKeyChange, runsDecoded } from "./run-key.js";
import {
  commandText,
  expand,
  fillXdg,
  fold,
  PATH,
  pathsIn,
  type RuleCtx,
  strings,
  toolPaths,
  under,
  unshell,
  withoutText,
} from "./paths.js";

/** Grok's folders (yours, where ion's gate hook lives, and a worktree's): `.grok` named, or a path into one. */
const ION_HOOK = /(^|[\s'"=/])\.grok(\/hooks(\/|$|[\s'";|&)])|\/?(?=$|[\s'";|&)]))/i;
const touchesHook = (req: ApprovalRequest, paths: string[], c: RuleCtx) =>
  [...strings(req.input)].some((v) => ION_HOOK.test(v) || ION_HOOK.test(unshell(v))) ||
  paths.some((p) => [...c.roots, c.home].some((r) => under(fold(p), fold(join(realish(r), ".grok")))));

const ionDirs = (c: RuleCtx) => c.ionDirs.map((d) => fold(realish(d)));
const rootsOf = (c: RuleCtx) => c.roots.map((r) => fold(realish(r)));

/**
 * Under one of ion's folders: never the run's, except its own worktree where that lives in ion's data folder
 * (an ion folder inside the project, such as ION_HOME there, is still ion's). Compared as the filesystem does:
 * without case on macOS (~/.CONFIG/ion is ~/.config/ion).
 */
const ionOwned = (p0: string, c: RuleCtx) => {
  const p = fold(p0);
  const roots = rootsOf(c);
  return ionDirs(c).some((dir) => under(p, dir) && !roots.some((r) => under(p, r) && under(r, dir)));
};

/** A folder that holds one of ion's: a search or a recursive copy from it reaches ion's files. */
const holdsIon = (p: string, c: RuleCtx) => ionDirs(c).some((d) => under(d, fold(p)));

const WILD = /[*?[\]{}]/;

/**
 * A path with a wildcard can match any of ion's folders under its literal start: it reaches one when that start
 * holds one of them or lies inside one (outside the run's own worktree).
 */
function globReaches(req: ApprovalRequest, c: RuleCtx): boolean {
  const texts = [...strings(req.input)].map(unshell);
  const raw = texts.flatMap((s) => [...s.matchAll(PATH)].map((m) => expand(m[0], c.home)));
  const words = texts.flatMap((s) => s.split(/[\s|;&]+/)).filter((w) => w && !/^[-/~$]/.test(w));
  const all = [...raw, ...words.map((w) => resolve(c.roots[0] ?? "/", w))];
  const roots = rootsOf(c);
  return all
    .filter((p) => WILD.test(p))
    .map((p) => {
      const lit = p.slice(0, p.search(WILD));
      return fold(realish(resolve(lit.slice(0, lit.lastIndexOf("/") + 1) || "/")));
    })
    .some(
      (start) =>
        !roots.some((r) => under(start, r)) && ionDirs(c).some((d) => under(d, start) || under(start, d)),
    );
}

/** Programs that read or copy a whole folder, always or with a recursive flag. */
/** Programs that read or copy a whole folder: always, or with their own recursive flags (`ls -la` isn't). */
const RECURSIVE = new Set(["find", "rg", "ag", "ack", "fd", "tar", "7z"]);
const RECURSIVE_FLAGS: Record<string, { short: string; long: string[] }> = {
  ls: { short: "R", long: ["--recursive"] },
  grep: { short: "rR", long: ["--recursive", "--dereference-recursive"] },
  egrep: { short: "rR", long: ["--recursive"] },
  fgrep: { short: "rR", long: ["--recursive"] },
  cp: { short: "rRa", long: ["--recursive", "--archive"] },
  scp: { short: "r", long: [] },
  rsync: { short: "ra", long: ["--recursive", "--archive"] },
  zip: { short: "r", long: ["--recurse-paths"] },
  chmod: { short: "R", long: ["--recursive"] },
  chown: { short: "R", long: ["--recursive"] },
};

/** Whether the program reads folders whole, given its words. */
function isRecursive(name: string, words: string[]): boolean {
  if (RECURSIVE.has(name)) return true;
  const f = RECURSIVE_FLAGS[name];
  if (!f) return false;
  // "--recursive=yes" is "--recursive"; "-R1" and "-1R" are clusters of letters and digits.
  return words.some((w) =>
    w.startsWith("--")
      ? f.long.includes(w.split("=")[0]!)
      : /^-[A-Za-z0-9]+$/.test(w) && [...w.slice(1)].some((ch) => f.short.includes(ch)),
  );
}

/** A word as a path: ~ and $HOME expanded, a relative one from the worktree. */
const asPath = (w: string, c: RuleCtx) => realish(resolve(c.roots[0] ?? "/", expand(w, c.home)));

/** The folders a recursive command reads: its arguments that aren't flags. */
function recursiveFolders(words: string[], c: RuleCtx): string[] {
  const progs = programsOf(words);
  const recursive = progs.some((p) => isRecursive(p.name, words));
  if (!recursive) return [];
  const programWords = new Set(progs.map((p) => p.at));
  return words
    .filter((w, i) => !programWords.has(i) && !/^[-<>]/.test(w) && !/^\w+=/.test(w))
    .map((w) => asPath(w, c));
}

/** A search tool's folders, or a recursive command's: does one hold ion's folders? */
function searchesIon(req: ApprovalRequest, c: RuleCtx): boolean {
  const command = commandText(req);
  const folders =
    req.kind === "search"
      ? [...strings(withoutText(req).input)].map((s) => asPath(unshell(s), c))
      : commandParts(command).flatMap((w) => recursiveFolders(w, c));
  return folders.some((p) => holdsIon(p, c));
}

/** A path in a script's text that's one of ion's (`~`, `$HOME` and `$XDG_*_HOME` filled in). */
const scriptNamesIon = (text: string, c: RuleCtx) =>
  [...fillXdg(text, c.home).matchAll(PATH)].some((m) => ionOwned(realish(resolve(expand(m[0], c.home))), c));

/**
 * Why ion refuses or is wary, and the safer route the agent is told (the user, 2026-11-21: every refusal suggests
 * one). wary: a guess, so ion asks you instead of refusing.
 */
export type Hard = { decision: "deny"; reason: string; route: string; wary?: true };
const refuse = (reason: string, route: string): Hard => ({ decision: "deny", reason, route });
const wary = (reason: string, route: string): Hard => ({ decision: "deny", reason, route, wary: true });

const SECRETS = refuse("Touches your secrets", "ask the user for the value instead");
const RUN_KEY = refuse("Changes the run's key", "leave ION_RUN_KEY and ION_CHAT as they are");
const ION_FILES = refuse("Touches ion's own files", "work in the project folder");
const ENV = refuse("Prints an environment, where keys are", "print only the variable you need");
const CLEARS = wary(
  "it clears the environment ion's commands need",
  "run it without clearing the environment",
);
const DECODED = wary("it runs text it decodes", "decode to a file, read it, then run it");
// One reason for every script ion can't read (made by this command, unreadable, not there yet), so an agent learns
// nothing about a file from ion's answer (Task 9 review, 2026-11-21: no probing).
const UNREAD = wary(
  "it runs a script ion can't read",
  "read the file first, then run it (create it in an earlier step)",
);
const SCRIPT = wary(
  "the script it runs changes the run's key or names ion's files",
  "run the commands you need directly",
);
const UNSURE = wary("it can't tell what this runs", "run it from the project folder, one step at a time");

/**
 * The scripts a command runs, read wherever you can read them (task review, 2026-11-21: refusing everything outside
 * the chat's folder broke `source ~/.nvm/nvm.sh`): one of ion's own is refused; one that drops the run's key or names
 * ion's files, one ion can't read (one the same command creates, say), or a command ion can't follow is a guess.
 */
function scriptsVerdict(command: string, c: RuleCtx): Hard | null {
  const all = scriptsIn(command);
  let found: Hard | null = all.some((s) => s.unsure) ? UNSURE : null;
  for (const s of all.filter((x) => !x.unsure && checked(x.file, c))) {
    const read = scriptText(s.file, c);
    if (read === ION) return ION_FILES;
    if (read === null) found ??= UNREAD;
    else if (scriptEscapes(read, c)) found ??= SCRIPT;
  }
  return found;
}

const ION = Symbol("ion's own");

/** A script's start, links followed; ION: one of ion's own. Null: not there, not a file, or can't be read. */
function scriptText(file: string, c: RuleCtx): string | null | typeof ION {
  const p = realish(resolve(c.roots[0] ?? "/", expand(file, c.home)));
  return ionOwned(p, c) ? ION : readStart(p);
}

/**
 * A script whose text decides: not a folder a launcher takes (`env -C /tmp`), nor a skill's script in the run's own
 * plugin folder (ion made it from skills you turned on; it goes to the judge).
 */
const checked = (file: string, c: RuleCtx) =>
  !isFolder(file, c) && !inPlugin(realish(resolve(c.roots[0] ?? "/", expand(file, c.home))), c);

/** Whether a word a command runs is a folder that's there. */
function isFolder(file: string, c: RuleCtx): boolean {
  try {
    return statSync(resolve(c.roots[0] ?? "/", file)).isDirectory();
  } catch {
    return false;
  }
}

/** A script's text: does it drop the run's key (a script ion can't read like a shell that names it at all) or name ion's files? */
const scriptEscapes = (text: string, c: RuleCtx): boolean =>
  NAMES_RUN_VAR.test(text) || dropsRunKey(text) || namesIonHome(text) || scriptNamesIon(text, c);

/** What the judge is shown of a guess: each script about to run (its start) and any text it decodes and runs. */
export type WaryData = { reason: string; scripts: { file: string; text?: string }[]; decoded: string[] };

/** A script in the chat's folder or the run's skills plugin (what the judge may be shown). */
const inProject = (file: string, c: RuleCtx) => {
  const p = realish(resolve(c.roots[0] ?? "/", expand(file, c.home)));
  return c.roots.some((r) => under(fold(p), fold(realish(r)))) || inPlugin(p, c);
};

const SCRIPT_SHOWN = 64 * 1024;
const SCRIPTS_SHOWN = 128 * 1024;
const DECODED_SHOWN = 8 * 1024;
const B64 = /^[A-Za-z0-9+/]{8,}={0,2}$/;

/** Text without control characters (newlines and tabs kept): what a terminal would hide. */
const visible = (t: string) =>
  [...t].filter((ch) => ch === "\n" || ch === "\t" || (ch >= " " && ch !== "\u007f")).join("");

/** base64 words a command decodes and runs, decoded by ion (only those that decode to plain text). */
function decodedIn(command: string): string[] {
  if (!runsDecoded(command)) return [];
  return unshell(command)
    .split(/[\s'"|;&()]+/)
    .filter((w) => B64.test(w))
    .map((w) => Buffer.from(w, "base64").toString("utf8"))
    .filter((t) => t.length > 0 && visible(t) === t && !t.includes("\ufffd"))
    .map((t) => t.slice(0, DECODED_SHOWN))
    .slice(0, 4);
}

/**
 * For the judge, on a guess (the user, 2026-11-21): the start of each script the command runs that ion can read (64
 * KB each, 128 KB in all, control characters dropped), any base64 it decodes and runs, decoded, and why ion is wary.
 * A script ion couldn't read (one the command creates) is left out: the reason says so.
 */
export function waryData(req: ApprovalRequest, c: RuleCtx, reason: string): WaryData {
  const command = commandText(req);
  const scripts: WaryData["scripts"] = [];
  let left = SCRIPTS_SHOWN;
  for (const s of scriptsIn(command).filter((x) => !x.unsure && checked(x.file, c))) {
    const read = scriptText(s.file, c);
    if (typeof read !== "string" || scripts.some((x) => x.file === s.file)) continue;
    // Only the project's scripts (or the run's skills') are shown; any other is named (security review, 2026-11-21).
    if (!inProject(s.file, c)) {
      scripts.push({ file: s.file });
      continue;
    }
    if (left <= 0) continue;
    const text = visible(read).slice(0, Math.min(SCRIPT_SHOWN, left));
    left -= text.length;
    scripts.push({ file: s.file, text });
  }
  return { reason, scripts, decoded: decodedIn(command) };
}

/** What ion knows is unsafe, in every mode: your secrets, the run's key, ion's own files, an environment dump. */
function refusal(req0: ApprovalRequest, c: RuleCtx): Hard | null {
  if (touchesKeychain(req0, c)) return SECRETS;
  const command = commandText(req0);
  if (runKeyChange(command) === "drops") return RUN_KEY;
  if (namesIonHome(command)) return ION_FILES;
  // A run's MCP keys and tokens are in its agent's environment.
  if (printsEnvironment(req0)) return ENV;
  const req = withoutText(req0);
  // A tool's relative paths count from the worktree, as it reads them.
  // The run's own skills plugin may be read and run (a skill's files and scripts), never written.
  const reads = readsOrRuns(req, c);
  const paths = [...pathsIn(req, c), ...toolPaths(req, c)].filter((p) => !(reads && inPlugin(p, c)));
  const ion =
    touchesHook(req, paths, c) ||
    paths.some((p) => ionOwned(p, c)) ||
    globReaches(req, c) ||
    searchesIon(req, c);
  return ion ? ION_FILES : null;
}

/**
 * What holds in every access mode, Full too, checked before anything allows (the user, 2026-11-21): refused, what ion
 * knows is unsafe (ion's own files, the keys in the keychain, an environment dump, dropping the run's key); wary, what
 * it only guesses (a script it can't read or that may escape, decoded text that runs, a launcher that clears the
 * environment, a command it can't follow), which asks you. Null: nothing here.
 *
 * In the OS sandbox (Plan 18 Task 12) the guesses go: each only guarded ion's key in daemon.json (a script or decoded
 * text naming ion's files, a cleared environment sending `ion` to daemon.json), which no process in the run can read
 * now. The refusals stay, as defence in depth: the keychain isn't in the sandbox's reach, nor an environment.
 */
export function hardRuleFor(req: ApprovalRequest, c: RuleCtx): Hard | null {
  const no = refusal(req, c);
  if (no) return no;
  const command = commandText(req);
  if (!command || c.sandboxed) return null;
  if (runKeyChange(command) === "clears") return CLEARS;
  if (runsDecoded(command)) return DECODED;
  return scriptsVerdict(command, c);
}

/**
 * ion's own folders: its data folder, the config's folder (config.toml, mcp.json), its folder in your cache (the
 * config opencode runs with in ion's chats) and a custom Grok folder.
 */
export const ionDirsOf = (o: { dataDir: string; configFile: string }): string[] => [
  ...ionFolders(o),
  ...(process.env.GROK_HOME ? [process.env.GROK_HOME] : []),
];
