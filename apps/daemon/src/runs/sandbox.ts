import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type RunSandbox, type SandboxKind, sandboxKind } from "@ion/adapter-kit";

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
  },
): RunSandbox | undefined {
  if (kind === "none") return undefined;
  const read = [o.pluginDir, o.ionBin].filter((p): p is string => !!p);
  return { kind, paths: { deny: ionFolders(o), read, write: [o.cwd], noWrite: [] } };
}

/** Whether an agent's chats run without a sandbox here (Settings → Agents: "Not sandboxed"). */
export const notSandboxed = (how: "own" | "ion" | undefined, kind: SandboxKind): boolean =>
  !how || kind === "none";

/**
 * The sandbox ion's local servers run in (Plan 18 Task 12): ion's folders denied (a server gets its values through its
 * env), plugins' data folders writable (`${CLAUDE_PLUGIN_DATA}`); each server's own folder is added where it starts.
 */
export function serverSandbox(
  o: { dataDir: string; configFile: string },
  kind: SandboxKind = machineSandbox(),
): RunSandbox | undefined {
  if (kind === "none") return undefined;
  return {
    kind,
    paths: { deny: ionFolders(o), read: [], write: [join(o.dataDir, "plugin-data")], noWrite: [] },
  };
}

/** What a run manager knows of the sandbox: how this computer sandboxes (default: found once), and ion's port. */
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
  l: { cwd: string; pluginDir?: string },
): LaunchSandbox {
  if (!how) return {};
  const sandbox = runSandbox(machineSandbox(ctx.sandbox), { ...ctx, cwd: l.cwd, pluginDir: l.pluginDir });
  return sandbox ? { sandbox, sandboxed: true } : {};
}
