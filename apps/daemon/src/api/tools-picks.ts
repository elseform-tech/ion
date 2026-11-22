import { loadUserConfig, ownToolsOn, type UserConfig } from "@ion/config";
import type { Commands, Picks } from "@ion/schema";
import type { IonServers } from "../ions/servers.js";
import type { Skills } from "../skills/index.js";
import { ownCommands } from "../skills/commands.js";
import { chatPicks, ionPicks, type PickSource, readsResources } from "../skills/picks.js";
import type { Tools } from "../tools/index.js";
import { consentOf, turnedOn } from "../tools/on.js";
import { agentsHomeOf, ownSwitches, repoState } from "../tools/own-run.js";
import { ownToolsOf } from "../tools/own.js";
import type { Db } from "../store/index.js";
import { chatsView } from "../views/chats.js";

type PickCtx = { tools: Tools; skills: Skills; configFile: string; ionServers?: IonServers };
type BoxCtx = PickCtx & { db: Db };

/** Your mcp.json servers, each with whether it's on (still what you turned on). */
async function yourServers(ctx: PickCtx, c: UserConfig): Promise<{ name: string; on: boolean }[]> {
  const on = turnedOn(c.tools.mcpOn);
  return Promise.all(
    ctx.tools.read().servers.map(async (s) => ({ name: s.name, on: (await consentOf(ctx.tools, s, on)).on })),
  );
}

/** An agent's own servers that reach its chats (its switch on; a repo's only once it's on or asks in the chat). */
async function ownServers(ctx: PickCtx, c: UserConfig, agent: string, projects: string[]) {
  if (!ownToolsOn(c, agent)) return [];
  const own = await ownToolsOf({
    ...agentsHomeOf(ctx.skills),
    ...{ projects, agents: ownSwitches(c) },
    repo: repoState(ctx.tools.sign, c.tools.repoOn),
  });
  return own.servers
    .filter((s) => s.agent === agent && (!s.repo || s.repo.on || s.repo.asks))
    .filter((s, i, all) => all.findIndex((x) => x.name === s.name) === i)
    .map((s) => ({ name: s.name }));
}

/**
 * Every server the agent has of its own, whatever its switch (Grok loads its config.toml's anyway): an ion's turn
 * never reaches a server by one of these names (task review, 2026-11-21).
 */
export async function ownServerNames(ctx: PickCtx, agent: string): Promise<string[]> {
  const { config } = loadUserConfig(ctx.configFile);
  const own = await ownToolsOf({
    ...agentsHomeOf(ctx.skills),
    ...{ projects: config.projects.map((p) => p.path), agents: ownSwitches(config) },
    repo: repoState(ctx.tools.sign, config.tools.repoOn),
  });
  return own.servers.filter((s) => s.agent === agent).map((s) => s.name);
}

/** What "/" and "@" are made from, for a chat on this agent in these projects' folders. */
export async function pickSource(ctx: PickCtx, agent: string, projects: string[]): Promise<PickSource> {
  const { config } = loadUserConfig(ctx.configFile);
  const own = ownToolsOn(config, agent);
  return {
    skills: await ctx.skills.list(config.tools.skills.on, projects, ownSwitches(config)),
    bodyOf: (s) => ctx.skills.bodyOf(projects, s),
    commands: own ? ownCommands(agent, { ...agentsHomeOf(ctx.skills), projects }) : [],
    ...(await servedOf(ctx, config, readsResources(agent))),
    own: await ownServers(ctx, config, agent, projects),
  };
}

/** Your servers, and the resources of the ones that are on (ion runs them, so it can list them for "@"). */
async function servedOf(ctx: PickCtx, c: UserConfig, resources: boolean) {
  const servers = await yourServers(ctx, c);
  const on = resources ? servers.filter((s) => s.on).map((s) => s.name) : [];
  const lists = await Promise.all(on.map(async (n) => [n, (await ctx.ionServers?.listResources(n)) ?? []]));
  return { servers, resources: Object.fromEntries(lists) as Record<string, { name: string; uri: string }[]> };
}

/** The projects' folders a message box is in: a chat's project, a project ion's own, or ion chief's shared ones. */
function foldersOf(ctx: BoxCtx, c: UserConfig, a: Commands["tools.picks"]["args"]): string[] {
  const chat = a.chatId ? chatsView.list(ctx.db).find((x) => x.chatId === a.chatId)?.projectId : undefined;
  const id = a.ionId && a.ionId !== "chief" ? a.ionId : (chat ?? a.projectId);
  if (id) return c.projects.filter((p) => p.id === id).map((p) => p.path);
  return a.ionId === "chief" ? c.projects.filter((p) => p.shareWithIon !== false).map((p) => p.path) : [];
}

/** "/" and "@" for a message box: a chat's (its agent's own, then ion's), or an ion's (what its threads can use). */
export async function picksFor(ctx: BoxCtx, a: Commands["tools.picks"]["args"]): Promise<Picks> {
  const { config } = loadUserConfig(ctx.configFile);
  const folders = foldersOf(ctx, config, a);
  if (a.ionId) {
    const skills = await ctx.skills.list(config.tools.skills.on, folders, ownSwitches(config));
    // An ion's turn names a resource to a thread, whose agent may not read it: servers by name only.
    return ionPicks({ skills, ...(await servedOf(ctx, config, false)) });
  }
  const agent = String(a.harness ?? "claude-code");
  return chatPicks(agent, await pickSource(ctx, agent, folders));
}
