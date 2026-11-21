import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { realish } from "../runs/policy.js";
import { fold, type RuleCtx, under, unshell } from "./paths.js";

/**
 * What a command runs: its programs, past wrappers and assignments, and the script files it hands to a shell or an
 * interpreter. One registry for the keychain rules and the run-key rules (task review, 2026-11-21: they drifted).
 */

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
/** Programs that run the next word as a program. */
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "exec",
  "command",
  "nohup",
  "time",
  "xargs",
  "eval",
  "nice",
  "timeout",
]);
/**
 * Interpreters: they run a script file named after them, or code given inline (`-c`, `-e`…). One registry for the
 * keychain rules and the run-key rules (task review, 2026-11-21: they drifted), by prefix too (`python3.12`, `node22`).
 */
const INTERPRETERS = new Set([
  "python",
  "node",
  "ruby",
  "perl",
  "deno",
  "bun",
  "php",
  "pwsh",
  "osascript",
  "awk",
  "Rscript",
  "tclsh",
]);
const VERSIONED = /^(python|node|ruby|perl|php)[\d.]*$/;
const isInterpreter = (name: string) => INTERPRETERS.has(name) || VERSIONED.test(name);
/** Programs that run a script file named after them: a shell, `.`/`source`, an interpreter. */
const runsScripts = (name: string) =>
  SHELLS.has(name) || name === "source" || name === "." || isInterpreter(name);
/** Programs that run what they're fed (a pipe, a substitution): those, busybox, xargs and eval. */
export const runsInput = (name: string): boolean =>
  runsScripts(name) || name === "busybox" || name === "xargs" || name === "eval";
const SCRIPT_BYTES = 64 * 1024;

/** Each simple command's words, read as the shell reads them (no quotes or escapes). */
export const commandParts = (command: string): string[][] =>
  unshell(command)
    .split(/[;|&\n()`]|\$\(/)
    .map((p) => p.trim().split(/\s+/).filter(Boolean))
    .filter((w) => w.length > 0);

/** A word that isn't a program: an assignment, a flag, a redirect or a number (a wrapper's argument). */
const notProgram = (w: string) => /^\w+=/.test(w) || /^[-<>]/.test(w) || /^\d+[smh]?$/.test(w);

/** The programs a command's words run: the first past `VAR=x` and wrappers, and again after `<shell> -c`. */
export function programsOf(words: string[]): { name: string; at: number }[] {
  const out: { name: string; at: number }[] = [];
  let expect = true;
  let last = "";
  words.forEach((w, at) => {
    if (!expect) {
      if (SHELLS.has(last) && /^-\w*c$/.test(w)) expect = true;
      return;
    }
    if (notProgram(w)) return;
    last = w.split("/").pop()!;
    out.push({ name: last, at });
    expect = WRAPPERS.has(last);
  });
  return out;
}

const PY_JS = /\.(py|js|mjs|cjs|ts|rb|pl|php|ps1|scpt|applescript|r|R|tcl|awk)$/;
/** unsure: a marker, not a file: ion can't tell what the command runs (the user, 2026-11-21: then it asks you). */
type Script = { file: string; shell: boolean; unsure?: true };
const UNSURE: Script = { file: "", shell: false, unsure: true };

/**
 * Real inline-code flags (no file to read): python -c, node -e/--eval/-p/--print, ruby/perl -e/-E, php -r,
 * Rscript -e, osascript -e, pwsh -Command/-c/-EncodedCommand. A shell's -c.
 */
const INLINE = new Set(["-c", "-e", "-E", "-p", "-r", "--eval", "--print", "-Command", "-EncodedCommand"]);
/** Flags whose next word is code for this interpreter (node's -r is a loader, not code). */
const codeFlag = (name: string, a: string) =>
  name.startsWith("node") || name === "deno" || name === "bun"
    ? a === "-e" || a === "--eval" || a === "-p" || a === "--print"
    : INLINE.has(a);
const SHELL_INLINE = (a: string) => /^-\w+$/.test(a) && a.includes("c");
/** Loader flags: the next word is a file the interpreter runs first (`node -r ./hook.js`, `python -m ./x`). */
const LOADERS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-m"]);
/**
 * Flags whose next word is their value, not the script, per interpreter family (Task review, 2026-11-21: `python -W
 * ignore x.py` read `ignore`).
 */
const PYTHON_VALUES = new Set(["-W", "-X", "--check-hash-based-pycs"]);
const NODE_VALUES = new Set([
  "--max-old-space-size",
  "--max-semi-space-size",
  "--stack-size",
  "--title",
  "--env-file",
  "--input-type",
  "--conditions",
  "-C",
  "--inspect-port",
  "--unhandled-rejections",
  "--report-dir",
  "--diagnostic-dir",
  "--redirect-warnings",
]);
const takesValue = (name: string, a: string) =>
  (name.startsWith("python") && PYTHON_VALUES.has(a)) ||
  ((name.startsWith("node") || name === "deno" || name === "bun") && NODE_VALUES.has(a));
/** Package managers' subcommands: what follows is a package script or task, not a file (unless it looks like one). */
const SUBCOMMANDS = new Set([
  "run",
  "task",
  "test",
  "x",
  "exec",
  "install",
  "add",
  "build",
  "fmt",
  "lint",
  "check",
]);
/** Where programs live: a program there run by its path is skipped only when it's root's own (systemProgram). */
const SYSTEM = /^\/(usr|bin|sbin|opt|System|Library|nix|Applications)\//;
/** A word that looks like a file (a path, or a name with an extension): `bun run test` names a package script. */
const fileLike = (w: string) => w.includes("/") || /\.\w+$/.test(w);

/**
 * A program where programs live that's root's own and not one you can change (automated review, 2026-11-21: a
 * user-writable file under /opt or /usr/local went unread).
 */
export function systemProgram(path: string): boolean {
  if (!SYSTEM.test(path)) return false;
  try {
    const st = statSync(path);
    return st.uid === 0 && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** A loader flag's file (python -m <module> runs a module by name; a path is a file to read). */
const loaderFile = (flag: string, f: string | undefined): Script[] =>
  f && (flag !== "-m" || f.includes("/")) ? [{ file: f, shell: false }] : [];

/** After a package manager's subcommand: `bun run x.ts` runs a file; `bun run test`, `deno task build` don't. */
const subcommandFile = (sub: string, next: string | undefined): Script[] =>
  next && sub === "run" && fileLike(next) ? [{ file: next, shell: false }] : [];

const looksLikeScript = (w: string) => w.includes("/") || PY_JS.test(w);

/**
 * A flag ion doesn't know, followed by a word that doesn't look like a script and then another: the first may be
 * the flag's value or the script (automated review, 2026-11-21: then ion can't tell, and asks you).
 */
const unknownFlag = (a: string, next: string | undefined, after: string | undefined) =>
  /^-[\w-]+$/.test(a) &&
  next !== undefined &&
  !next.startsWith("-") &&
  !looksLikeScript(next) &&
  after !== undefined;

/** A flag's value, read as a script only when it looks like one. */
const valueScript = (next: string | undefined): Script[] =>
  next && looksLikeScript(next) ? [{ file: next, shell: false }] : [];

/** One word of an interpreter's: the scripts it names, and whether the reading stops here. */
function interpreterWord(
  name: string,
  [a, next, after]: (string | undefined)[],
): { scripts: Script[]; stop: boolean; skip?: true } {
  if (a === undefined || codeFlag(name, a)) return { scripts: [], stop: true }; // inline code: nothing to read
  if (LOADERS.has(a)) return { scripts: loaderFile(a, next), stop: a === "-m", skip: true };
  // A value that looks like a script is read anyway (automated review, 2026-11-21).
  if (takesValue(name, a)) return { scripts: valueScript(next), stop: false, skip: true };
  if (unknownFlag(a, next, after)) return { scripts: [UNSURE], stop: true };
  if (notProgram(a)) return { scripts: [], stop: false };
  if (SUBCOMMANDS.has(a) && (name === "bun" || name === "deno"))
    return { scripts: subcommandFile(a, next), stop: true };
  return { scripts: [{ file: a, shell: false }], stop: true };
}

/** An interpreter's scripts: each loader flag's file, then the first word it runs (whatever its name). */
function interpreterScripts(name: string, args: string[]): Script[] {
  const out: Script[] = [];
  for (let i = 0; i < args.length; i++) {
    const w = interpreterWord(name, args.slice(i, i + 3));
    out.push(...w.scripts);
    if (w.stop) break;
    if (w.skip) i++;
  }
  return out;
}

/** The script files a runner's words name. */
function runnerScripts(name: string, args: string[]): Script[] {
  if (name === "awk") {
    const f = args[args.indexOf("-f") + 1];
    return args.includes("-f") && f ? [{ file: f, shell: false }] : [];
  }
  if (isInterpreter(name)) return interpreterScripts(name, args);
  if (args.some(SHELL_INLINE)) return [];
  const next = args.find((x) => !notProgram(x) && x !== "sh");
  return next ? [{ file: next, shell: !PY_JS.test(next) }] : [];
}

/** The scripts a part runs: `bash x.sh`, `. x`, `python3 x`, `node -r h.js a.js`, `./x`, `busybox sh x`. */
function scriptOf(words: string[]): Script[] {
  for (const { name, at } of programsOf(words)) {
    const w = words[at]!;
    if (name === "busybox" || runsScripts(name)) return runnerScripts(name, words.slice(at + 1));
    // A script run by its path: `./x`, or `/…/x` unless it's root's own program.
    if (w.includes("/") && !systemProgram(w)) return [{ file: w, shell: !PY_JS.test(w) }];
  }
  return [];
}

/** `cat x | sh`: the file a part feeds through a pipe to a shell (the next part). */
function pipedScript(words: string[], next: string | undefined): Script[] {
  const feedsShell = next && programsOf(next.trim().split(/\s+/)).some((p) => SHELLS.has(p.name));
  const file = words[0] === "cat" ? words.slice(1).find((x) => !x.startsWith("-")) : undefined;
  return feedsShell && file ? [{ file, shell: true }] : [];
}

/** Where a script may be read from: the worktree, or the run's own skills plugin (a skill's scripts). */
const readable = (p: string, c: RuleCtx) =>
  c.roots.some((r) => under(p, realish(r))) || (!!c.plugin && under(fold(p), fold(realish(c.plugin))));

/**
 * A file's start, or null (not there, not a regular file, can't be read). Opened without blocking and checked on the
 * open file (Task review, 2026-11-21: a FIFO swapped in after a check would block the daemon on open).
 */
export function readStart(p: string): string | null {
  try {
    const fd = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) return null;
      const buf = Buffer.alloc(SCRIPT_BYTES);
      return buf.subarray(0, readSync(fd, buf, 0, SCRIPT_BYTES, 0)).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The start of a script in the worktree or the run's skills plugin, or null (not there, not a file, elsewhere). */
export function readScript(file: string, c: RuleCtx): string | null {
  const p = realish(resolve(c.roots[0] ?? "/", file));
  return readable(p, c) ? readStart(p) : null;
}

/** Where a `cd`/`pushd` names (null: unknown here, `cd -` or popd). No folder: home. */
function cdTarget(words: string[]): string | null {
  if (words[0] === "popd") return null;
  const to = words.slice(1).find((w) => !w.startsWith("-") || w === "-");
  if (to === "-") return null;
  return to ?? "~";
}

const moveTo = (dir: string, to: string) =>
  to.startsWith("/") || to.startsWith("~") || !dir ? to : join(dir, to);

/** A script's file as seen from a folder the command may have moved to. */
const from = (dir: string, s: Script): Script =>
  !dir || s.file.startsWith("/") || s.file.startsWith("~") ? s : { ...s, file: join(dir, s.file) };

const MAX_DIRS = 8;
const CD = new Set(["cd", "pushd", "popd"]);

/** A cd ion can't follow: behind a launcher or assignment (`builtin cd`, `command cd`, `X=1 cd`). */
const hiddenCd = (words: string[]) =>
  (words[0] === "builtin" && CD.has(words[1] ?? "")) ||
  programsOf(words).some((p) => p.at > 0 && CD.has(p.name));

/** The folders after a cd: surely moved (`&&`) or maybe moved (both kept); null: unknown (`cd -`, popd). */
function afterCd(dirs: string[], to: string | null, sure: boolean): string[] | null {
  if (to === null) return null;
  const moved = dirs.map((d) => moveTo(d, to));
  return sure ? moved : [...new Set([...dirs, ...moved])];
}

type Walk = { dirs: string[]; seen: Set<string>; unsure: boolean };

/** One part's cd: moves the walk's folders, or marks it unsure (a cd it can't follow, or too many folders). */
function walkCd(w: Walk, words: string[], sure: boolean): void {
  const next = afterCd(w.dirs, cdTarget(words), sure);
  if (next === null || next.length > MAX_DIRS) w.unsure = true;
  else w.dirs = next;
  for (const d of w.dirs) w.seen.add(d);
}

/** One part's scripts (and the file it pipes to a shell), from each folder the command may be in. */
function partScripts(w: Walk, words: string[], piped: string | undefined): Script[] {
  if (hiddenCd(words)) w.unsure = true;
  const found = [...scriptOf(words), ...(piped === undefined ? [] : pipedScript(words, piped))];
  return found.flatMap((s) => (s.unsure ? [s] : w.dirs.map((d) => from(d, s))));
}

/**
 * Every script a command runs, from each folder it may be in (Task review, 2026-11-21: scripts after a cd were
 * looked for in the chat's folder): by its runner, by its path, or fed to a shell through a pipe. Only `cd x && …`
 * surely moves; a cd that may fail (`;`, `||`) or a subshell's end keeps each folder it may be in, so each copy is
 * checked. Whatever ion can't follow (a hidden cd, `cd -`, popd, too many folders, a flag it doesn't know) adds
 * UNSURE (automated review, 2026-11-21: never silently allowed).
 */
export function scriptsIn(command: string): Script[] {
  const tokens = unshell(command).split(/(&&|\|\||[;|&\n()`]|\$\()/);
  const w: Walk = { dirs: [""], seen: new Set([""]), unsure: false };
  const out: Script[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const words = tokens[i]!.trim().split(/\s+/).filter(Boolean);
    const after = tokens[i + 1];
    if (CD.has(words[0] ?? "")) walkCd(w, words, after === "&&");
    else out.push(...partScripts(w, words, after === "|" ? tokens[i + 2] : undefined));
    if (after === ")") w.dirs = [...w.seen].slice(0, MAX_DIRS);
  }
  return w.unsure ? [...out, UNSURE] : out;
}
