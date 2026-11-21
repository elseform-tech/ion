import { loadUserConfig, type UserConfig } from "@ion/config";
import type { Commands, ToolsInfo } from "@ion/schema";
import { toolSupport } from "../adapters/registry.js";
import { CANT_READ_KEYCHAIN, keyAccount } from "../secrets/index.js";
import { EXPOSED, refsOf, type Tools } from "../tools/index.js";
import type { Ctx, Handlers } from "./commands.js";
import { projectDirs, withOrigins } from "./tools-entries.js";
import { UserError } from "./errors.js";
import { changeConfig } from "./settings.js";
import { mcpInfo } from "./tools-mcp.js";
import { remoteToSignIn } from "./tools-oauth.js";
import { hookChange, hookGroups } from "./tools-hooks.js";
import type { Skills } from "../skills/index.js";
import type { YourTools } from "../mcp/ion-your-tools.js";
import { consentOf, turnedOn } from "../tools/on.js";
import { agentsHomeOf, ownSwitches, repoKey, repoState } from "../tools/own-run.js";
import { ownToolsOf, repoMaterial, repoServers, runsRepoCode } from "../tools/own.js";

const KEY_NAME = /^[A-Za-z_]\w{0,63}$/;
const MAX_KEY = 16_384;
async function toolsInfo(
  ctx: Pick<Ctx, "tools" | "oauth" | "configFile" | "hooks" | "skills" | "added" | "db" | "seen">,
): Promise<ToolsInfo> {
  const { tools } = ctx;
  const r = tools.read();
  const { config } = loadUserConfig(ctx.configFile);
  const { mcp, keychain } = await mcpInfo(ctx, r.servers, config.tools.mcpOn);
  const problem = r.problem ?? (r.exposed ? EXPOSED : undefined);
  const { leftOut, ...own } = await ownToolsOf({
    ...agentsHomeOf(ctx.skills),
    ...{ projects: projectDirs(config), agents: ownSwitches(config) },
    repo: repoState(ctx.tools.sign, config.tools.repoOn),
  });
  const info: ToolsInfo = {
    mcpFile: tools.file.path,
    ...(problem ? { mcpProblem: problem } : {}),
    ...(keychain ? { keychainProblem: keychain } : {}),
    mcp,
    // mcp.json's, then a repo's own whose name breaks the rule.
    leftOut: [...r.leftOut, ...leftOut],
    hooks: await hookGroups(config, ctx.hooks, ctx.tools.sign),
    skills: await ctx.skills.list(config.tools.skills.on, projectDirs(config), ownSwitches(config)),
    support: toolSupport(),
    own,
  };
  return withOrigins(ctx, info, r.servers);
}

/**
 * Your tools for an ion's `tools`: each connection and whether it's on (no sign-in is probed), the skills in your home
 * and these projects' folders, and what each agent takes.
 */
export function yourToolsOf(ctx: { tools: Tools; skills: Skills; configFile: string }): YourTools {
  return async (projectDirs) => {
    const { config } = loadUserConfig(ctx.configFile);
    const on = turnedOn(config.tools.mcpOn);
    const servers = await Promise.all(
      ctx.tools.read().servers.map(async (server) => ({
        server,
        on: (await consentOf(ctx.tools, server, on)).on,
      })),
    );
    const skills = await ctx.skills.list(config.tools.skills.on, projectDirs, ownSwitches(config));
    return { servers, skills, support: toolSupport() };
  };
}

const hookCtx = (ctx: { configFile: string; tools: Tools }) => ({
  configFile: ctx.configFile,
  sign: ctx.tools.sign,
});

/**
 * A server turned on is kept with what it runs now (its consent hash): if that changes it's off again. Off: it
 * leaves the list.
 */
async function mcpTurned(tools: Tools, c: UserConfig, id: string, on: boolean): Promise<string[]> {
  const kept = c.tools.mcpOn.filter((e) => e.slice(0, e.lastIndexOf("@")) !== id);
  const s = tools.read().servers.find((x) => x.name === id);
  if (!s && (on || kept.length === c.tools.mcpOn.length)) throw new UserError(`Unknown connection: ${id}`);
  if (!on || !s) return kept;
  const mark = await tools.consent(s).catch(() => {
    throw new UserError(CANT_READ_KEYCHAIN);
  });
  return [...kept, `${id}@${mark}`];
}

/**
 * Turning a repo's own server on (a project's .mcp.json, "<project>:<name>") is consent to exactly what it runs now
 * (security review, 2026-11-21); off takes that back.
 */
async function repoTurned(tools: Tools, c: UserConfig, id: string, on: boolean): Promise<string[]> {
  const kept = c.tools.repoOn.filter((e) => e.slice(0, e.lastIndexOf("@")) !== id);
  if (!on) return kept;
  const [project, name] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
  const dir = projectDirs(c).find((p) => repoKey(p, name) === id);
  const v = dir ? repoServers(dir)[name] : undefined;
  if (!dir || v === undefined || !project) throw new UserError(`Unknown connection: ${id}`);
  // A repo's local server has no lasting consent (ruling, 2026-11-21): ion asks in each chat.
  if (runsRepoCode(v)) throw new UserError("It runs code from the repo: ion asks in each chat");
  const mark = await tools.sign(repoMaterial(dir, name, v)).catch(() => {
    throw new UserError(CANT_READ_KEYCHAIN);
  });
  return [...kept, `${id}@${mark}`];
}

/** Turning a skill on is consent to exactly what's in it now; off takes that back. */
async function skillTurned(skills: Skills, c: UserConfig, id: string, on: boolean): Promise<string[]> {
  if (!id || id.length > 1000) throw new UserError("Unknown skill");
  return skills.turn(c.tools.skills.on, id, on, { projects: projectDirs(c), own: ownSwitches(c) });
}

async function setOn(
  ctx: Parameters<typeof toolsInfo>[0],
  a: Commands["tools.setOn"]["args"],
): Promise<void> {
  const now = loadUserConfig(ctx.configFile).config;
  const id = String(a.id ?? "");
  if (a.kind === "mcp") {
    const mcpOn = await mcpTurned(ctx.tools, now, id, a.on);
    return changeConfig(ctx.configFile, (c) => ({ ...c, tools: { ...c.tools, mcpOn } }));
  }
  if (a.kind === "repo") {
    const repoOn = await repoTurned(ctx.tools, now, id, a.on);
    return changeConfig(ctx.configFile, (c) => ({ ...c, tools: { ...c.tools, repoOn } }));
  }
  if (a.kind !== "skill") throw new UserError("Pick a connection, a hook or a skill");
  const on = await skillTurned(ctx.skills, now, id, a.on);
  changeConfig(ctx.configFile, (c) => ({ ...c, tools: { ...c.tools, skills: { ...c.tools.skills, on } } }));
}

/** A key as pasted: one line, trimmed. Refusals never repeat it. */
function keyOf(v: unknown): string {
  const k = typeof v === "string" ? v.trim() : "";
  if (!k) throw new UserError("Paste the key");
  if (k.length > MAX_KEY) throw new UserError("That key is too long");
  if (/\p{Cc}/u.test(k)) throw new UserError("Paste the key on one line");
  return k;
}

async function setKey(tools: Tools, a: Commands["tools.setKey"]["args"]): Promise<void> {
  const id = String(a.id ?? "");
  const name = String(a.name ?? "");
  if (/^ion_/i.test(name)) throw new UserError("ION_ names are ion's own");
  if (!KEY_NAME.test(name)) throw new UserError("That key name can't be used");
  const key = keyOf(a.key);
  const s = tools.read().servers.find((x) => x.name === id);
  if (!s) throw new UserError(`Unknown connection: ${id}`);
  if (!refsOf(s).includes(name)) throw new UserError(`${id} doesn't use \${${name}}`);
  await tools.secrets.set(keyAccount(id, name), key).catch((e: Error) => {
    throw new UserError(e.message);
  });
}

/**
 * Settings → Tools: connections from mcp.json (on or off, their keys), your hooks, and your agents' skills (on or off),
 * kept in ion's config.
 */
export const toolsHandlers: Pick<
  Handlers,
  | "tools.list"
  | "tools.setOn"
  | "tools.setKey"
  | "tools.addHook"
  | "tools.updateHook"
  | "tools.removeHook"
  | "tools.signIn"
  | "tools.signOut"
> = {
  "tools.list": (_a, ctx) => toolsInfo(ctx),
  "tools.setOn": async (a, ctx) => {
    if (typeof a.on !== "boolean") throw new UserError("Pick on or off");
    if (a.kind === "hook") {
      await hookChange(hookCtx(ctx), { op: a.on ? "on" : "off", id: String(a.id ?? "") });
      return toolsInfo(ctx);
    }
    await setOn(ctx, a);
    return toolsInfo(ctx);
  },
  "tools.setKey": async (a, ctx) => {
    await setKey(ctx.tools, a);
    return toolsInfo(ctx);
  },
  "tools.addHook": async (a, ctx) => {
    await hookChange(hookCtx(ctx), { op: "add", args: a });
    return toolsInfo(ctx);
  },
  "tools.updateHook": async (a, ctx) => {
    await hookChange(hookCtx(ctx), { op: "update", args: a });
    return toolsInfo(ctx);
  },
  "tools.removeHook": async (a, ctx) => {
    await hookChange(hookCtx(ctx), { op: "remove", id: String(a.id ?? "") });
    return toolsInfo(ctx);
  },
  "tools.signIn": async (a, ctx) => {
    const id = await remoteToSignIn(ctx.tools, a.id);
    const given =
      a.clientId === undefined ? undefined : { clientId: a.clientId, clientSecret: a.clientSecret };
    return ctx.oauth.signIn(id, given);
  },
  "tools.signOut": async (a, ctx) => {
    await ctx.oauth.signOut(await remoteToSignIn(ctx.tools, a.id));
    return toolsInfo(ctx);
  },
};
