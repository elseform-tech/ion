import { type HookEntry, loadUserConfig, type UserConfig } from "@ion/config";
import {
  TOOL_TYPES,
  type SkillInfo,
  type ToolItem,
  type ToolType,
  type ToolOrigin,
  type ToolsInfo,
} from "@ion/schema";
import { consentOf as hookConsent, hookHasher, usableHooks } from "../hooks/consent.js";
import { launchHash } from "../tools/added.js";
import type { McpServer } from "../tools/mcp-file.js";
import { consentOf, turnedOn } from "../tools/on.js";
import { chatsView } from "../views/chats.js";
import type { Ctx } from "./commands.js";
import { UserError } from "./errors.js";

/** One connection, hook or skill as ion's commands see it: what its record of who added it is keyed by. */
export type Entry = ToolItem & {
  /** What it runs, as `added` keys it. */
  hash: string;
  mcp?: McpServer;
  hook?: HookEntry;
  skill?: SkillInfo;
  /** Why ion leaves it out (a bad mcp.json entry). */
  why?: string;
};

export const mcpHash = (s: McpServer) =>
  launchHash(["mcp", s.transport === "http" ? [s.url, s.headers] : [s.command, s.args, s.env]]);
export const hookHash = (h: Pick<HookEntry, "event" | "run">) => launchHash(["hook", h.event, h.run]);
export const skillHash = (id: string) => launchHash(["skill", id]);

export const projectDirs = (c: UserConfig) => c.projects.map((p) => p.path);

export function kindOf(v: unknown): ToolType {
  if (!TOOL_TYPES.includes(v as ToolType)) throw new UserError("Pick mcp, skill or hook");
  return v as ToolType;
}

/** Where it came from and who added it, while it still runs what was added. */
export function originOf(
  ctx: Pick<Ctx, "added" | "db" | "caller">,
  kind: ToolType,
  id: string,
  hash: string,
): ToolOrigin | undefined {
  const r = ctx.added.find(kind, id, hash);
  if (!r) return undefined;
  const o: ToolOrigin = { by: r.chatId ? "agent" : "you", at: r.at };
  // Security review, 2026-11-21: a chat's agent sees nothing of what another chat added but that a chat added it.
  if (ctx.caller && r.chatId !== ctx.caller.chatId) return o;
  if (r.source) o.source = r.source;
  if (r.link) o.link = r.link;
  const named = r.chatId;
  if (!named) return o;
  o.chatId = named;
  const title = chatsView.list(ctx.db).find((c) => c.chatId === named)?.title;
  if (title) o.chatTitle = title;
  return o;
}

async function mcpEntries(ctx: Ctx, c: UserConfig): Promise<Entry[]> {
  const r = ctx.tools.read();
  const on = turnedOn(c.tools.mcpOn);
  const kept = await Promise.all(
    r.servers.map(async (s) => ({
      ...{ kind: "mcp" as const, name: s.name, id: s.name, hash: mcpHash(s), mcp: s },
      on: (await consentOf(ctx.tools, s, on)).on,
    })),
  );
  const out = r.leftOut.map((l) => ({
    kind: "mcp" as const,
    name: l.name,
    id: l.name,
    on: false,
    hash: "",
    why: l.why,
  }));
  return [...kept, ...out];
}

async function hookEntries(ctx: Ctx, c: UserConfig): Promise<Entry[]> {
  const mine = usableHooks(c.tools.hooks);
  const hash = await hookHasher(ctx.tools.sign, mine);
  return mine.map((h) => ({
    ...{ kind: "hook" as const, name: h.name, id: h.id, hash: hookHash(h), hook: h },
    on: hookConsent(h, c.tools.hooksOn, hash).on,
  }));
}

async function skillEntries(ctx: Ctx, c: UserConfig): Promise<Entry[]> {
  const all = await ctx.skills.list(c.tools.skills.on, projectDirs(c));
  return all.map((s) => ({
    kind: "skill" as const,
    name: s.name,
    id: s.id,
    on: s.on,
    hash: skillHash(s.id),
    skill: s,
  }));
}

/** Every connection, hook or skill of a kind, on or off. */
export async function entries(ctx: Ctx, kind: ToolType): Promise<Entry[]> {
  const { config } = loadUserConfig(ctx.configFile);
  if (kind === "mcp") return mcpEntries(ctx, config);
  return kind === "hook" ? hookEntries(ctx, config) : skillEntries(ctx, config);
}

/** One by its name (or id): unknown ones are said plainly. */
export async function entry(ctx: Ctx, kind: ToolType, name: string): Promise<Entry> {
  const e = (await entries(ctx, kind)).find((x) => x.name === name || x.id === name);
  if (!e) throw new UserError(`Unknown ${kind === "mcp" ? "connection" : kind}: ${name}`);
  return e;
}

export function itemOf(ctx: Ctx, e: Entry): ToolItem {
  const origin = originOf(ctx, e.kind, e.id, e.hash);
  return { kind: e.kind, name: e.name, id: e.id, on: e.on, ...(origin ? { origin } : {}) };
}

/** With its origin, when it has one. */
const marked = <T extends object>(x: T, origin: ToolOrigin | undefined): T => (origin ? { ...x, origin } : x);

/** Settings → Tools with where each row came from and who added it (an agent: which chat). */
export function withOrigins(
  ctx: Pick<Ctx, "added" | "db" | "seen">,
  info: ToolsInfo,
  servers: McpServer[],
): ToolsInfo {
  const hashOf = new Map(servers.map((s) => [s.name, mcpHash(s)]));
  const shown: string[] = [];
  // New until Settings has shown it once (Task review, 2026-11-21): what it runs counts, so a changed one is New again.
  const row = <T extends { new?: true }>(x: T, kind: ToolType, id: string, hash: string): T => {
    const key = `${kind}:${id}:${hash}`;
    const { new: fresh, ...rest } = marked(x, originOf(ctx, kind, id, hash));
    if (!fresh) return rest as T;
    if (ctx.seen.has(key)) return rest as T;
    shown.push(key);
    return { ...rest, new: true } as T;
  };
  const out = {
    ...info,
    mcp: info.mcp.map((m) => row(m, "mcp", m.id, hashOf.get(m.id) ?? "")),
    hooks: info.hooks.map((g) => ({ ...g, hooks: g.hooks.map((h) => row(h, "hook", h.id, hookHash(h))) })),
    skills: info.skills.map((s) => row(s, "skill", s.id, skillHash(s.id))),
  };
  ctx.seen.add(shown);
  return out;
}
