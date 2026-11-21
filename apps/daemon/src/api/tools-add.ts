import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { EV, type HookEvent, stripControl, type ToolAdd, type ToolItem, type ToolType } from "@ion/schema";
import { readSkillFolder } from "../skills/find.js";
import { literalKey } from "../tools/literal.js";
import { addServer, type McpEntry } from "../tools/mcp-file.js";
import { getPublic, searchRegistry } from "../tools/registry.js";
import { urlHoldsKey } from "../tools/secretish.js";
import { chatsView } from "../views/chats.js";
import type { Ctx } from "./commands.js";
import { UserError } from "./errors.js";
import { changeConfig } from "./settings.js";
import { hookHash, kindOf, mcpHash, originOf, skillHash } from "./tools-entries.js";
import { hookChange } from "./tools-hooks.js";

/** What was added: its name, its id (a hook's or skill's own), and what it runs (for who-added-it). */
type Made = { name: string; id: string; hash: string };

const SKILL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const REGISTRY_ID = /^[\w.@-]{1,100}\/[\w.@-]{1,100}$/;
const MAX_SKILL_MD = 256 * 1024;

const text = (v: unknown) => (typeof v === "string" ? v : "");
const textList = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const textMap = (v: unknown): Record<string, string> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]))
    : undefined;

/** `--from`: a registry id (`io.github.owner/name`) or an https link, kept as given; never one holding a key. */
function sourceOf(from: unknown): string | undefined {
  const f = stripControl(text(from)).trim();
  if (!f) return undefined;
  if (REGISTRY_ID.test(f)) return f;
  if (!/^https:\/\/\S{1,300}$/.test(f)) throw new UserError("--from takes a registry id or an https link");
  if (urlHoldsKey(f)) throw new UserError("Put keys in Settings");
  return f;
}

/**
 * Where a source opens: an https link as given; a registry id, its repo (or site) as the MCP Registry lists it (Task
 * review, 2026-11-21: never the registry's JSON). None when the registry can't say.
 */
async function linkOf(ctx: Ctx, source: string | undefined): Promise<string | undefined> {
  if (!source || source.startsWith("https://")) return source;
  const hits = await searchRegistry(ctx.net, source).catch(() => []);
  return hits.find((h) => h.id === source)?.source;
}

/** A records list without this name's (so what's added starts off, whatever was turned on under that name before). */
const others = (records: string[], id: string) =>
  records.filter((r) => r.slice(0, r.lastIndexOf("@")) !== id);

/**
 * A shell fills `${NAME}` in double quotes with nothing: an empty value is that, not a server with no key. Each map
 * is checked on its own; the name (an agent's) is cleaned before it's said.
 */
function refuseEmpty(values: Record<string, string> | undefined): void {
  const empty = Object.entries(values ?? {}).find(([, v]) => !v.replace(/^\s*bearer\s*/i, "").trim());
  if (!empty) return;
  const name = stripControl(empty[0]).replace(/\s+/g, " ").trim().slice(0, 80);
  throw new UserError(`${name} is empty. Write keys as '\${NAME}', in single quotes`);
}

/**
 * The entry as mcp.json will hold it: a remote one (`--url`, headers) or a local one (`--command`, args, env). A key
 * typed in anywhere is refused: keys are `${NAME}`s, kept in Settings.
 */
function entryOf(a: Extract<ToolAdd, { kind: "mcp" }>): McpEntry {
  const command = text(a.command).trim();
  const url = text(a.url).trim();
  if (!command === !url) throw new UserError("Give it --command or --url");
  const entry = url
    ? remoteEntry(url, textMap(a.headers))
    : localEntry(command, textList(a.args), textMap(a.env));
  const why = literalKey(entry);
  if (why) throw new UserError(why);
  return entry;
}

function remoteEntry(url: string, headers: Record<string, string> | undefined) {
  refuseEmpty(headers);
  return { type: "http" as const, url, ...(headers ? { headers } : {}) };
}

function localEntry(command: string, args: string[], env: Record<string, string> | undefined) {
  refuseEmpty(env);
  return { command, ...(args.length ? { args } : {}), ...(env ? { env } : {}) };
}

function addMcp(ctx: Ctx, a: Extract<ToolAdd, { kind: "mcp" }>): Made {
  const name = text(a.name);
  const entry = entryOf(a);
  let s: ReturnType<typeof addServer>;
  try {
    s = addServer(ctx.tools.file.path, name, entry);
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  changeConfig(ctx.configFile, (c) => ({ ...c, tools: { ...c.tools, mcpOn: others(c.tools.mcpOn, name) } }));
  return { name, id: name, hash: mcpHash(s) };
}

async function addHook(ctx: Ctx, a: Extract<ToolAdd, { kind: "hook" }>): Promise<Made> {
  const run = text(a.run).trim();
  if (literalKey({ run })) throw new UserError("Put keys in Settings");
  const name = text(a.name).trim() || (run.length > 40 ? `${run.slice(0, 39)}…` : run);
  const id = `h-${randomUUID().slice(0, 8)}`;
  const args = { name, event: a.event as HookEvent, run };
  await hookChange({ configFile: ctx.configFile, sign: ctx.tools.sign }, { op: "add", args, id, off: true });
  return { name, id, hash: hookHash(args) };
}

/** A GitHub page of a file (`…/blob/<branch>/<path>`) as the file itself; any other link as it is. */
const rawLink = (u: URL) => {
  const m = u.hostname === "github.com" ? /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname) : null;
  return m ? new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`) : u;
};

/** A SKILL.md from a public link: written into the skill's new folder. */
async function skillFromLink(ctx: Ctx, link: string, target: string): Promise<void> {
  const r = await getPublic(ctx.net, rawLink(new URL(link))).catch(() => null);
  if (!r || r.status !== 200) throw new UserError("ion couldn't get that link");
  if (r.text.length > MAX_SKILL_MD || !/^---\r?\n[\s\S]*?\bname:/.test(r.text))
    throw new UserError("That link isn't a SKILL.md");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(join(target, "SKILL.md"), r.text, { mode: 0o600 });
}

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** A chat's agent copies a skill only from its own worktree; you, from any folder. */
function mayRead(ctx: Ctx, folder: string): void {
  if (!ctx.caller) return;
  const wt = chatsView.worktree(ctx.db, ctx.caller.chatId);
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  if (!wt || !inside(real(folder), real(wt))) throw new UserError("Use a folder in this chat's worktree");
}

/** A skill's folder, read as ion reads any skill (no links, no dotfiles, size-capped), copied file by file. */
function skillFromFolder(ctx: Ctx, folder: string, target: string): void {
  if (!isAbsolute(folder)) throw new UserError("--from takes an https link or a full folder path");
  mayRead(ctx, folder);
  const found = readSkillFolder(folder, ctx.skills.home);
  if (!found) throw new UserError("That folder has no SKILL.md ion can read");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(join(target, "SKILL.md"), found.md, { mode: 0o600 });
  for (const f of found.files) {
    const to = join(target, f.rel);
    if (!inside(to, target)) continue;
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    writeFileSync(to, f.bytes, { mode: 0o600 });
  }
}

async function addSkill(ctx: Ctx, a: Extract<ToolAdd, { kind: "skill" }>): Promise<Made> {
  const name = text(a.name);
  if (!SKILL_NAME.test(name)) throw new UserError("Use up to 64 letters, digits, - or _");
  const dir = ctx.skills.ionDir;
  if (!dir) throw new UserError("ion has no skills folder");
  const target = join(dir, name);
  if (existsSync(target)) throw new UserError(`${name} is already added`);
  const from = text(a.from).trim();
  if (from.startsWith("https://")) await skillFromLink(ctx, from, target);
  else skillFromFolder(ctx, from, target);
  const found = readSkillFolder(target, ctx.skills.home);
  if (!found) {
    rmSync(target, { recursive: true, force: true });
    throw new UserError("That isn't a skill ion can read");
  }
  changeConfig(ctx.configFile, (c) => ({
    ...c,
    tools: { ...c.tools, skills: { ...c.tools.skills, on: others(c.tools.skills.on, found.id) } },
  }));
  return { name: found.name, id: found.id, hash: skillHash(found.id) };
}

function make(ctx: Ctx, kind: ToolType, a: ToolAdd): Made | Promise<Made> {
  if (kind === "mcp") return addMcp(ctx, a as Extract<ToolAdd, { kind: "mcp" }>);
  if (kind === "hook") return addHook(ctx, a as Extract<ToolAdd, { kind: "hook" }>);
  return addSkill(ctx, a as Extract<ToolAdd, { kind: "skill" }>);
}

/**
 * `ion <kind> add`: written off (you turn it on in Settings → Tools, where any sign-in happens), with where it came
 * from and who added it kept in ion's data. A chat's agent adding one: the chat says so in one line.
 */
export async function addTool(ctx: Ctx, a: ToolAdd): Promise<ToolItem> {
  const kind = kindOf(a.kind);
  // A skill copied from a folder has no source to link to.
  const local = kind === "skill" && !text(a.from).startsWith("https://");
  const source = local ? undefined : sourceOf(a.from);
  const made = await make(ctx, kind, a);
  const { caller } = ctx;
  const link = await linkOf(ctx, source);
  ctx.added.put({
    ...{ kind, name: made.id, hash: made.hash, at: new Date().toISOString() },
    ...(source ? { source } : {}),
    ...(link ? { link } : {}),
    ...(caller ? { chatId: caller.chatId } : {}),
  });
  if (caller)
    ctx.store.append({
      ...{ chatId: caller.chatId, runId: caller.runId, origin: "daemon" },
      ...{ type: EV.toolAdded, data: { kind, name: made.name.slice(0, 80) } },
    });
  const origin = originOf(ctx, kind, made.id, made.hash);
  return { kind, name: made.name, id: made.id, on: false, ...(origin ? { origin } : {}) };
}
