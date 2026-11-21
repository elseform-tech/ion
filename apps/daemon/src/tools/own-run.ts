import { homedir } from "node:os";
import { basename, join } from "node:path";
import { agentEnv, type EnvDrop, type McpSpec } from "@ion/adapter-kit";
import { loadUserConfig, ownToolsOn, type UserConfig } from "@ion/config";
import { harnessIds } from "../adapters/registry.js";
import { pluginDirOf, writePlugin } from "../skills/plugin.js";
import { type RunSkills, skillsFor } from "../skills/run.js";
import { standardLaunch } from "./import.js";
import { claudeOwnForRun, type RepoOn, type RepoState, repoMaterial, runsRepoCode } from "./own.js";
import { envDropOf } from "./env-drop.js";
import { turnedOn } from "./on.js";
import { type Sign, sameMark } from "../secrets/consent-key.js";

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
  forRun(r: Asking & { harness: string; cwd: string; pluginDir?: string }): Promise<OwnForRun>;
};

/** The run a question is asked in. */
type Asking = { runId: string; chatId: string; projectId: string };

/** Asks you in the run's chat; true for "Allow for this chat". */
export type AskInChat = (r: Asking, text: string, command: string) => Promise<boolean>;

/**
 * A chat run's agent's own tools (the user, 2026-11-21: on by default, "Use its own tools" per agent). Codex, opencode
 * and Grok load theirs themselves (the adapter is told); Claude Code's servers and plugins are read here and passed. A
 * plugin with hooks comes as ion's copy without them, inside the run's skills plugin folder (in ion's data folder,
 * readable by the run like its skills, gone when it ends).
 */
export function runOwnOf(o: {
  home: string;
  dataDir: string;
  configFile: string;
  sign: Sign;
  /** ion's environment (a stand-in in tests); only what an agent may have of it fills `${VAR}`. */
  env?: NodeJS.ProcessEnv;
  /** Asks you in a chat about a repo's server that runs the repo's own code; none: it doesn't come. */
  ask?: AskInChat;
}): RunOwn {
  /** Repo servers you allowed for a chat ("<chat> <project> <name> <as written>"): for that chat only. */
  const allowed = new Set<string>();
  return {
    async forRun(r) {
      const { config } = loadUserConfig(o.configFile);
      const ownTools = ownToolsOn(config, r.harness);
      if (!ownTools || r.harness !== "claude-code") return { ownTools, secrets: [] };
      const project = config.projects.find((p) => p.id === r.projectId)?.path ?? r.cwd;
      const pluginDir = r.pluginDir ?? pluginDirOf(o.dataDir, r.runId);
      if (!r.pluginDir) await writePlugin(pluginDir, []);
      const env = agentOnly(o.env ?? agentsHomeOf(o).env, await envDropOf(o.configFile));
      const lasting = repoConsent(o.sign, project, config.tools.repoOn);
      const repoOn: RepoOn = (name, v) =>
        runsRepoCode(v) ? askedFor(o.ask, allowed, { ...r, project, name, v }) : lasting(name, v);
      const own = await claudeOwnForRun({ home: o.home, env, project, dir: join(pluginDir, "own"), repoOn });
      return { ownTools, ownServers: own.servers, ownPlugins: own.plugins, pluginDir, secrets: own.secrets };
    },
  };
}

/**
 * What fills `${VAR}` in an agent's own server (security review, 2026-11-21): the environment an agent may have, less
 * every variable of ion's own (`ION_*`: run keys, ion's settings), never ion's whole environment.
 */
const agentOnly = (env: NodeJS.ProcessEnv, drop: EnvDrop): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(agentEnv(env, drop)).filter(([k]) => !k.startsWith("ION_")));

/** A repo's server's record ("<project>:<name>"). */
export const repoKey = (project: string, name: string) => `${basename(project)}:${name}`;

/** Whether you turned on a repo's server, exactly as it is now (its record verifies with ion's key). */
export const repoState =
  (sign: Sign, repoOn: string[]): RepoState =>
  async (project, name, v) => {
    // Code from the repo has no lasting consent: it's asked about in each chat.
    if (runsRepoCode(v)) return { on: false, new: true, asks: true };
    const was = turnedOn(repoOn).get(repoKey(project, name));
    if (was === undefined) return { on: false, new: true };
    const now = await sign(repoMaterial(project, name, v)).catch(() => null);
    if (now === null) return { on: false };
    return sameMark(was, now) ? { on: true } : { on: false, changed: true };
  };

/**
 * A repo server that runs the repo's own code, for one chat (ruling, 2026-11-21): allowed already in this chat, else
 * asked there now ("<project>'s .mcp.json wants to run <server> from the repo"); no one to ask: it doesn't come.
 */
async function askedFor(
  ask: AskInChat | undefined,
  allowed: Set<string>,
  a: Asking & { project: string; name: string; v: unknown },
): Promise<boolean> {
  const key = `${a.chatId} ${a.project} ${a.name} ${JSON.stringify(a.v)}`;
  if (allowed.has(key)) return true;
  const l = isLaunch(a.v);
  const command = l ? [l.command, ...l.args].join(" ") : "";
  // The name passed the name rule (own.ts); quoted, so it reads as a name, not words of the question.
  const text = `${basename(a.project)}'s .mcp.json wants to run "${a.name}" from the repo`;
  const yes = (await ask?.(a, text, command).catch(() => false)) ?? false;
  if (yes) allowed.add(key);
  return yes;
}

const isLaunch = (v: unknown) => {
  const l = typeof v === "object" && v !== null ? standardLaunch(v as Record<string, unknown>) : null;
  return l?.kind === "stdio" ? l : null;
};

/** For a run in this project: a repo server comes only while it's on. */
const repoConsent =
  (sign: Sign, project: string, repoOn: string[]): RepoOn =>
  async (name, v) =>
    (await repoState(sign, repoOn)(project, name, v)).on;

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
  l: { runId: string; chatId: string; projectId: string; cwd: string; h: { adapter: { id: string } } },
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
