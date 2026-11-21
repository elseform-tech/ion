import { homedir } from "node:os";
import { join } from "node:path";
import type { McpSpec } from "@ion/adapter-kit";
import { loadUserConfig, ownToolsOn, type UserConfig } from "@ion/config";
import { harnessIds } from "../adapters/registry.js";
import { pluginDirOf, writePlugin } from "../skills/plugin.js";
import { type RunSkills, skillsFor } from "../skills/run.js";
import { claudeOwnForRun } from "./own.js";

/** By agent id: its "Use its own tools" switch. */
export const ownSwitches = (c: Pick<UserConfig, "agents">): Record<string, boolean> =>
  Object.fromEntries(harnessIds().map((id) => [id, ownToolsOn(c, id)]));

/** Where your agents keep their config: your home (and ion's environment), or a stand-in one (tests, the tour). */
export const agentsHomeOf = (skills: { home: string }) => ({
  home: skills.home,
  env: skills.home === homedir() ? process.env : {},
});

/** What a chat's run brings of its agent's own (Claude Code: read for it here), and the values to redact. */
export type OwnForRun = {
  ownTools: boolean;
  ownServers?: McpSpec[];
  ownPlugins?: string[];
  /** The run's skills plugin folder, made when Claude Code's own plugins need ion's copies (they live inside it). */
  pluginDir?: string;
  secrets: string[];
};

export type RunOwn = {
  forRun(r: {
    runId: string;
    harness: string;
    projectId: string;
    cwd: string;
    pluginDir?: string;
  }): Promise<OwnForRun>;
};

/**
 * A chat run's agent's own tools (the user, 2026-11-21: on by default, "Use its own tools" per agent). Codex, opencode
 * and Grok load theirs themselves (the adapter is told); Claude Code's servers and plugins are read here and passed. A
 * plugin with hooks comes as ion's copy without them, inside the run's skills plugin folder (in ion's data folder,
 * readable by the run like its skills, gone when it ends).
 */
export function runOwnOf(o: { home: string; dataDir: string; configFile: string }): RunOwn {
  return {
    async forRun(r) {
      const { config } = loadUserConfig(o.configFile);
      const ownTools = ownToolsOn(config, r.harness);
      if (!ownTools || r.harness !== "claude-code") return { ownTools, secrets: [] };
      const project = config.projects.find((p) => p.id === r.projectId)?.path ?? r.cwd;
      const pluginDir = r.pluginDir ?? pluginDirOf(o.dataDir, r.runId);
      if (!r.pluginDir) await writePlugin(pluginDir, []);
      const own = await claudeOwnForRun({ ...agentsHomeOf(o), project, dir: join(pluginDir, "own") });
      return { ownTools, ownServers: own.servers, ownPlugins: own.plugins, pluginDir, secrets: own.secrets };
    },
  };
}

/** A run's own tools; one ion can't read is said in the daemon's log and the run goes on with its agent's own off. */
const ownFor = (own: RunOwn | undefined, l: Parameters<RunOwn["forRun"]>[0]): Promise<OwnForRun> =>
  (own?.forRun(l) ?? Promise.resolve({ ownTools: false, secrets: [] })).catch((e: Error) => {
    console.warn(`own tools: a run's agent's own tools couldn't be read: ${e.name}`);
    return { ownTools: false, secrets: [] };
  });

/** What the agent is told of its own: whether to bring it, and Claude Code's servers and plugins. */
export const ownOpts = (own?: OwnForRun) =>
  own?.ownTools
    ? {
        ownTools: true,
        ...(own.ownServers ? { ownServers: own.ownServers } : {}),
        ...(own.ownPlugins ? { ownPlugins: own.ownPlugins } : {}),
      }
    : {};

/** A chat run's skills plugin (null: none) and its agent's own tools (which may need that folder, and make it). */
export async function skillsAndOwn(
  ctx: { skills?: RunSkills; own?: RunOwn },
  l: { runId: string; projectId: string; cwd: string; h: { adapter: { id: string } } },
): Promise<{ pluginDir?: string; own: OwnForRun }> {
  const skills = (await skillsFor(ctx.skills, l)) ?? undefined;
  const own = await ownFor(ctx.own, {
    ...l,
    harness: l.h.adapter.id,
    ...(skills ? { pluginDir: skills } : {}),
  });
  const pluginDir = own.pluginDir ?? skills;
  return { own, ...(pluginDir ? { pluginDir } : {}) };
}
