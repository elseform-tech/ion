import { createRequire, syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { accessSync, constants } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { afterEach } from "vitest";

/**
 * No test starts your real agents (AGENTS.md: no real model calls in tests; 2026-11-28: `pnpm check` ran your real
 * `claude auth status`, `opencode acp` and `grok agent stdio` for ion's sign-in and model checks). In every test
 * worker, starting claude, codex, grok or opencode from outside the run's temp folder (a stand-in a test made is fine)
 * is refused, and fails the test. Live evals (ION_LIVE*) run them on purpose.
 */
const AGENTS = new Set(["claude", "codex", "grok", "opencode"]);

const isLive = () =>
  Object.entries(process.env).some(([k, v]) => /^ION_LIVE(_[A-Z]+)?$/.test(k) && v === "1");

const runnable = (file: string) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** `cmd` as the file it runs: itself when it has a folder, else the first match on `path`. */
function resolve(cmd: string, path: string | undefined): string {
  if (cmd.includes("/")) return cmd;
  const dir = (path ?? "").split(delimiter).find((d) => d && runnable(join(d, cmd)));
  return dir ? join(dir, cmd) : cmd;
}

/** Why starting `cmd` is refused (one of your agents, from outside the run's folder), or null. */
export function realAgent(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const name = basename(cmd.trim().split(/\s/)[0] ?? "");
  if (!AGENTS.has(name) || isLive()) return null;
  const file = resolve(cmd.trim().split(/\s/)[0]!, env.PATH);
  const run = process.env.TMPDIR;
  if ((run && file.startsWith(`${run}/`)) || !runnable(file)) return null;
  return `A test started your real ${name} (${file}): use a stand-in, or a live eval (ION_LIVE*)`;
}

const refused: string[] = [];

type Fn = (...args: unknown[]) => unknown;

const ORIGINAL = Symbol.for("ion.test-temp.original");

/** Refuses (and remembers) a start of one of your agents. */
function check(args: unknown[]): void {
  const opts = args.find((a) => a && typeof a === "object" && !Array.isArray(a)) as {
    env?: NodeJS.ProcessEnv;
  };
  const why = typeof args[0] === "string" ? realAgent(args[0], opts?.env ?? process.env) : null;
  if (!why) return;
  refused.push(why);
  throw new Error(why);
}

/** Wraps child_process's `name` so a real agent is refused before it starts (once: each test file installs it). */
function guard(cp: Record<string, unknown>, name: string): void {
  const original = ((cp[name] as { [ORIGINAL]?: Fn })[ORIGINAL] ?? cp[name]) as Fn;
  const checked = (run: Fn) =>
    function (this: unknown, ...args: unknown[]) {
      check(args);
      return run.apply(this, args);
    };
  const wrapped: Fn & { [k: symbol]: unknown } = checked(original);
  wrapped[ORIGINAL] = original;
  // exec and execFile have their own promisified form ({ stdout, stderr }): kept, and guarded too.
  const custom = (original as { [k: symbol]: unknown })[promisify.custom];
  if (typeof custom === "function") wrapped[promisify.custom] = checked(custom as Fn);
  cp[name] = wrapped;
}

/** Installs the guard in this worker; every test then fails if one of its spawns was refused. */
function installGuard(): void {
  const cp = createRequire(import.meta.url)("node:child_process") as Record<string, unknown>;
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) guard(cp, name);
  syncBuiltinESMExports();
}

/** What was refused since the last call (and forgets it). */
export function takeRefused(): string[] {
  return refused.splice(0);
}

installGuard();
afterEach(() => {
  const r = takeRefused();
  if (r.length) throw new Error(r.join("\n"));
});
