import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadUserConfig, mcpFileOf } from "@ion/config";
import { type RunSandbox, type SandboxKind, sandboxKind } from "@ion/adapter-kit";
import { sandboxGit } from "../workspace/index.js";

let said = false;

/**
 * How this computer sandboxes chats' agents (docs/research/sandbox.md). Without one, runs still start: Settings →
 * Agents says "Not sandboxed", and the daemon's log says so once.
 */
export function machineSandbox(kind: SandboxKind = sandboxKind()): SandboxKind {
  if (kind === "none" && !said) {
    console.warn(
      "ion: chats' agents are not sandboxed on this computer (no sandbox-exec or bubblewrap that works)",
    );
    said = true;
  }
  return kind;
}

/** ion's own folders, out of every run's reach: its data folder, its config's folder and its folder in your cache. */
export const ionFolders = (o: { dataDir: string; configFile: string; cacheDir?: string }): string[] => [
  o.dataDir,
  dirname(o.configFile),
  join(o.cacheDir ?? (process.env.XDG_CACHE_HOME || join(homedir(), ".cache")), "ion"),
];

/** Each agent's own config, where it keeps its settings, hooks, servers and skills. */
const CONFIGS: Record<string, (env: NodeJS.ProcessEnv, home: string) => string[]> = {
  codex: (env, home) => [env.CODEX_HOME || join(home, ".codex")],
  "claude-code": (env, home) => [env.CLAUDE_CONFIG_DIR || join(home, ".claude"), join(home, ".claude.json")],
  opencode: (env, home) => [
    join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode"),
    join(home, ".opencode"),
  ],
  "grok-build": (env, home) => [env.GROK_HOME || join(home, ".grok")],
};

/**
 * Every other agent's config, read-only to a run (task review, 2026-11-21: a Grok run could add a hook to ~/.claude
 * for a later chat). The run's own agent keeps writing its sessions and state; the adapter guards its config files.
 */
export function agentConfigs(harness: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || homedir();
  const others = Object.entries(CONFIGS).flatMap(([id, paths]) => (id === harness ? [] : paths(env, home)));
  return [...others, ...ALWAYS(env, home)];
}

/**
 * Read-only to every run, its own agent's too (final review, 2026-11-22): opencode's npm plugin cache, whose code a
 * later opencode start loads. opencode runs without writing it (it only refreshes its models list there; checked live).
 */
const ALWAYS = (env: NodeJS.ProcessEnv, home: string) => [
  join(env.XDG_CACHE_HOME || join(home, ".cache"), "opencode"),
];

/** `p` inside `dir` (or `dir` itself). */
const within = (p: string, dir: string) => {
  const r = relative(dir, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

/**
 * What a sandbox denies of ion's: its data folder, its cache folder, and its config folder, whole, unless your projects
 * live in it (ION_HOME holding them: the tour, tests), then ion's own files there (config.toml, mcp.json, its skills).
 */
export function ionDenied(o: { dataDir: string; configFile: string; cacheDir?: string }): string[] {
  const [data, dir, cache] = ionFolders(o) as [string, string, string];
  let projects: string[] = [];
  try {
    const { config } = loadUserConfig(o.configFile);
    projects = [expandHome(config.folders.projects), ...config.projects.map((p) => p.path)];
  } catch {
    // no config yet: nothing of yours in it
  }
  const shared = projects.some((p) => within(resolve(p), resolve(dir)));
  const config = shared ? [o.configFile, mcpFileOf(o.configFile), join(dir, "skills")] : [dir];
  return [data, ...config, cache];
}

/**
 * A chat's run's sandbox (the user, 2026-11-21): ion's folders denied, except the run's worktree (read and write),
 * its skills plugin and ion's `ion` launcher (read and run). None where the computer has no sandbox.
 */
export function runSandbox(
  kind: SandboxKind,
  o: {
    dataDir: string;
    configFile: string;
    cacheDir?: string;
    cwd: string;
    pluginDir?: string;
    ionBin?: string;
    /** The run's agent: every other agent's config is read-only to it. */
    harness?: string;
    env?: NodeJS.ProcessEnv;
  },
): RunSandbox | undefined {
  if (kind === "none") return undefined;
  const read = [o.pluginDir, o.ionBin].filter((p): p is string => !!p);
  const noWrite = agentConfigs(o.harness ?? "", o.env);
  return { kind, paths: { deny: ionDenied(o), read, write: [o.cwd], noWrite }, dataDir: o.dataDir };
}

/**
 * The sandbox of one of ion's own agent processes (the judge, ion's quick model, an ion's turn; final review,
 * 2026-11-22): a run's, in its folder; none where the computer has none.
 */
export function ownAgentSandbox(
  o: { dataDir: string; configFile: string; sandbox?: SandboxKind },
  cwd: string,
  harness: string,
): { sandbox?: RunSandbox } {
  const sandbox = runSandbox(o.sandbox ?? machineSandbox(), { ...o, cwd, harness });
  return sandbox ? { sandbox } : {};
}

/** Whether an agent's chats run without a sandbox here (Settings → Agents: "Not sandboxed"). */
export const notSandboxed = (how: "own" | "ion" | undefined, kind: SandboxKind): boolean =>
  !how || kind === "none";

/**
 * The sandbox ion's local servers run in (Plan 18 Task 12): ion's folders denied (a server gets its values through its
 * env), plugins' data folders writable (`${CLAUDE_PLUGIN_DATA}`); each server's own folder is added where it starts.
 */
export const serverSandbox = (
  o: { dataDir: string; configFile: string },
  kind?: SandboxKind,
  env?: NodeJS.ProcessEnv,
) => deniedWith(o, [join(o.dataDir, "plugin-data")], kind, env);

/**
 * ion's folders denied, every agent's config read-only (re-review, 2026-11-21: a planted git filter wrote
 * ~/.codex/notify.sh, which Codex runs outside any sandbox), these writable; none where the computer has none.
 */
function deniedWith(
  o: { dataDir: string; configFile: string },
  write: string[],
  kind: SandboxKind = machineSandbox(),
  env: NodeJS.ProcessEnv = process.env,
): RunSandbox | undefined {
  if (kind === "none") return undefined;
  return {
    kind,
    paths: { deny: ionDenied(o), read: [], write, noWrite: agentConfigs("", env) },
    dataDir: o.dataDir,
  };
}

export type SandboxCtx = {
  /** How this computer sandboxes chats' agents ("none" runs them as they are). */
  sandbox?: SandboxKind;
  /** ion's port, for `ion` inside a run (ION_PORT: daemon.json is out of the run's reach). */
  port?: () => number;
};

/** A run's sandbox, and whether it's in it (ion's guesses that only guarded its key go then). */
export type LaunchSandbox = { sandbox?: RunSandbox; sandboxed?: boolean };

/** A chat's run's sandbox, when its agent sandboxes and this computer can (said once in the log when it can't). */
export function launchSandbox(
  how: "own" | "ion" | undefined,
  ctx: SandboxCtx & { dataDir: string; configFile: string; ionBin?: string },
  l: { cwd: string; pluginDir?: string; harness: string },
): LaunchSandbox {
  if (!how) return {};
  const at = { cwd: l.cwd, pluginDir: l.pluginDir, harness: l.harness };
  const sandbox = runSandbox(machineSandbox(ctx.sandbox), { ...ctx, ...at });
  if (!sandbox) return {};
  // Only ion's own sandbox relaxes ion's word rules: Codex's own process, its own stdio servers and notify run outside
  // any sandbox, and an escalation that drops its sandbox isn't ruled out live yet (task review, 2026-11-21).
  return how === "ion" ? { sandbox, sandboxed: true } : { sandbox };
}

/**
 * The sandbox ion's own git runs in (security review, 2026-11-21: a filter planted in a project's git config ran in
 * the daemon's diff): ion's folders denied, its chats' worktrees writable (it makes and reads them).
 */
export const gitSandbox = (
  o: { dataDir: string; configFile: string },
  kind?: SandboxKind,
  env?: NodeJS.ProcessEnv,
) => deniedWith(o, [join(o.dataDir, "worktrees")], kind, env);

/** How this computer sandboxes (said once in the log when it can't), with ion's own git put in the sandbox. */
export function startSandbox(o: { dataDir: string; configFile: string }): SandboxKind {
  const kind = machineSandbox();
  sandboxGit(gitSandbox(o, kind));
  return kind;
}

/**
 * The sandbox your hooks run in (automated review, 2026-11-21: a hook can run code an agent wrote in the project):
 * ion's folders denied, ion's launcher readable, every agent's config read-only; the project as it is (writable).
 */
export function hookSandbox(
  o: { dataDir: string; configFile: string },
  ionBin?: string,
): RunSandbox | undefined {
  const sb = deniedWith(o, []);
  return sb && ionBin ? { ...sb, paths: { ...sb.paths, read: [ionBin] } } : sb;
}
