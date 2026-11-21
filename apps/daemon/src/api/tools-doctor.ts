import { accessSync, constants, mkdtempSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { stripControl, type ToolCheck, type ToolType } from "@ion/schema";
import { maskKeys } from "../hooks/mask.js";
import { fillServer, keysNeeded, refsOf } from "../tools/fill.js";
import type { McpServer } from "../tools/mcp-file.js";
import { getPublic, packageFound } from "../tools/registry.js";
import { hookEnv, runHook } from "../workspace/hooks.js";
import { bridgesFor, type StdioSpec } from "../workspace/mcp-bridge.js";
import { UserError } from "./errors.js";
import type { Ctx } from "./commands.js";
import { type Entry, entries, entry, itemOf } from "./tools-entries.js";
import { ownServerChecks } from "./tools-own-check.js";

/** A hook's test run, at most this long. */
const HOOK_TEST_MS = 10_000;
/** Starting a server that's on and listing its tools, at most this long. */
const LIST_MS = 10_000;
/** Words `/bin/sh` knows itself: never looked for on PATH. */
const SHELL_WORDS = new Set([
  ...["cd", "echo", "test", "[", "if", "for", "while", "case", "export", "exit", "true", "false", "printf"],
  ...["read", "set", "source", ".", ":", "exec", "eval", "{", "(", "!"],
]);

const runnable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Whether a command would be found: a path that runs, or a name on ion's PATH. Nothing is run to find out. */
function onPath(command: string): boolean {
  if (command.includes("/")) return runnable(command);
  return (process.env.PATH ?? "").split(delimiter).some((d) => d !== "" && runnable(join(d, command)));
}

const clip = (s: string) => stripControl(s).slice(0, 80);

/** The package npx or uvx would fetch (its first word that isn't a flag), without its version. */
function packageOf(s: McpServer & { transport: "stdio" }): { kind: "npm" | "pypi"; name: string } | null {
  const tool = s.command.split("/").pop();
  const word = s.args.find((a) => !a.startsWith("-"));
  if (!word || word.includes("${")) return null;
  if (tool === "npx") return { kind: "npm", name: /^(@?[^@]+)/.exec(word)?.[1] ?? word };
  if (tool === "uvx") return { kind: "pypi", name: word.split(/[=<>@[]/)[0]! };
  return null;
}

/**
 * A chat's agent is told the key names a server uses, never whether you have them (Task review, 2026-11-21: that was
 * an oracle for your keychain).
 */
function keyNames(s: McpServer): string[] {
  const names = refsOf(s).filter((n) => !/^ion_/i.test(n));
  return names.length ? [`Uses keys: ${names.join(", ")}`] : [];
}

async function keyProblems(ctx: Ctx, s: McpServer): Promise<string[]> {
  const k = await keysNeeded(s, ctx.tools.lookup).catch(() => null);
  if (!k) return [];
  if (k.keychain) return [k.keychain];
  return k.missing.length ? [`Needs a key: ${k.missing.join(", ")}`] : [];
}

/** A local server's safe checks: its command is there, its package is published. Nothing is started. */
export async function localProblems(ctx: Ctx, s: McpServer & { transport: "stdio" }): Promise<string[]> {
  if (!s.command.includes("${") && !onPath(s.command)) return [`Command not found: ${clip(s.command)}`];
  const pkg = packageOf(s);
  const found = pkg ? await packageFound(ctx.net, pkg.kind, pkg.name) : true;
  if (found === false) return [`Package not found: ${clip(pkg!.name)}`];
  return found === null ? ["ion couldn't check its package"] : [];
}

/**
 * A remote server that's off: its URL as written (nothing filled, no headers, no token), one GET to a public address.
 * Security review, 2026-11-21: filling it would send your keys wherever an agent's entry points.
 */
export async function offRemoteProblems(ctx: Ctx, s: McpServer & { transport: "http" }): Promise<string[]> {
  if (s.url.includes("${")) return ["ion checks its URL once it's on"];
  const r = await getPublic(ctx.net, new URL(s.url)).catch(() => null);
  if (!r) return ["Can't reach it"];
  return r.status === 401 ? ["Needs sign-in"] : [];
}

/** A remote server that's on (you consented): whether it answers 401 (Needs sign-in) and isn't signed in yet. */
async function remoteProblems(ctx: Ctx, s: McpServer): Promise<string[]> {
  const status = await ctx.oauth.status(s.name, { probe: true }).catch(() => null);
  if (status === "sign in") return ["Needs sign-in"];
  if (status === "sign in again") return ["Needs sign-in again"];
  return status === "can't reach" ? ["Can't reach it"] : [];
}

/** A local server that's on, started through ion's bridge (as a run would) only to list its tools. */
async function toolsOf(ctx: Ctx, s: McpServer): Promise<string[] | string> {
  const filled = await fillServer(s, ctx.tools.lookup).catch(() => null);
  if (!filled || !("server" in filled)) return "Needs a key";
  // Its own new folder (removed after), never a shared one anything could have written to.
  const folder = mkdtempSync(join(tmpdir(), "ion-mcp-check-"));
  const bridges = bridgesFor([filled.server as StdioSpec], { folder, stopped: () => {} });
  const local = bridges.get(s.name)!;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<string>((r) => {
    timer = setTimeout(() => r("Didn't answer in 10 s"), LIST_MS);
  });
  const list = async () => {
    const init = {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ion", version: "0" },
    };
    await local.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: init });
    const r = (await local.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })) as {
      result?: { tools?: { name?: unknown }[] };
    };
    const tools = r?.result?.tools;
    return Array.isArray(tools) ? tools.slice(0, 100).map((t) => clip(String(t.name ?? ""))) : "Didn't start";
  };
  try {
    return await Promise.race([list(), late]);
  } finally {
    clearTimeout(timer);
    await bridges.close();
  }
}

async function mcpCheck(ctx: Ctx, e: Entry): Promise<{ problems: string[]; tools?: string[] }> {
  const s = e.mcp!;
  const keys = ctx.caller ? [] : await keyProblems(ctx, s);
  const info = ctx.caller ? keyNames(s) : [];
  // A remote server is asked whether it needs a sign-in only once its keys are there.
  let own: string[] = [];
  if (s.transport === "stdio") own = await localProblems(ctx, s);
  else if (!e.on) own = await offRemoteProblems(ctx, s);
  else if (!keys.length) own = await remoteProblems(ctx, s);
  const problems = [...own, ...keys];
  if (problems.length || !e.on || s.transport !== "stdio") return { problems: [...problems, ...info] };
  const tools = await toolsOf(ctx, s);
  if (typeof tools !== "string") return { problems: info, tools };
  return { problems: [ctx.caller ? "Didn't start" : tools, ...info] };
}

/** A hook's safe check: the command it starts with is there. It isn't run. */
function hookProblems(e: Entry): string[] {
  const first = e.hook?.run.trim().split(/\s+/)[0] ?? "";
  if (!first || SHELL_WORDS.has(first) || /[=$'"`\\]/.test(first) || onPath(first)) return [];
  return [`Command not found: ${clip(first)}`];
}

/** What a hook's test run says: nothing when it went well, else why, in a few words. */
function ranProblems(r: { code: number | null; timedOut: boolean }): string[] {
  if (r.timedOut) return ["Took too long"];
  if (r.code === null) return ["Didn't start"];
  return r.code === 0 ? [] : [`Exited with ${r.code}`];
}

/**
 * A hook: its command is there; one that's on (you consented) is also run once with a test event, in your home
 * folder, up to 10 s. You see the end of its output (keys masked); a chat's agent only whether it went well.
 */
async function hookCheck(ctx: Ctx, e: Entry): Promise<{ problems: string[]; output?: string }> {
  const missing = hookProblems(e);
  const h = e.hook;
  // Task review, 2026-11-21: a chat's agent never runs a hook through doctor; it only learns the command is there.
  if (missing.length || !e.on || !h || ctx.caller) return { problems: missing };
  const r = await runHook({
    ...{ run: h.run, stdin: JSON.stringify({ type: h.event, test: true }), cwd: homedir() },
    ...{ env: hookEnv({ event: h.event }), limitMs: HOOK_TEST_MS },
  });
  return { problems: ranProblems(r), output: await maskKeys(r.tail, ctx.configFile) };
}

async function checkOne(ctx: Ctx, e: Entry): Promise<ToolCheck> {
  const item = itemOf(ctx, e);
  if (e.why) return { ...item, problems: [e.why] };
  if (e.kind === "mcp") return { ...item, ...(await mcpCheck(ctx, e)) };
  if (e.kind === "hook") return { ...item, ...(await hookCheck(ctx, e)) };
  return skillCheck(ctx, e);
}

/** The agent whose folder a skill is in (the shared folder and ion's own are no one agent's). */
const WHOSE: Partial<Record<string, string>> = {
  claude: "claude-code",
  codex: "codex",
  opencode: "opencode",
};

/** A skill: it has a description; an agent's own says whose (checked read-only, the agent manages it). */
export function skillCheck(ctx: Ctx, e: Entry): ToolCheck {
  const agent = e.skill?.own ?? (e.skill ? WHOSE[e.skill.whose] : undefined);
  const own = agent ? { agent } : {};
  if (e.why) return { ...itemOf(ctx, e), ...own, problems: [e.why] };
  return { ...itemOf(ctx, e), ...own, problems: e.skill?.description ? [] : ["No description"] };
}

/**
 * `ion <kind> doctor [name]`: each problem in one plain line. Nothing that's off is ever started or filled in: only its
 * entry, its command, its package (a registry GET) or its URL as written (a GET, public addresses only) are checked. A local server that's on is
 * started through ion's bridge to list its tools.
 */
export async function doctor(ctx: Ctx, kind: ToolType, name?: string): Promise<ToolCheck[]> {
  const own = kind === "mcp" ? () => ownServerChecks(ctx, name) : async () => [];
  if (name === undefined && ctx.caller)
    return everyOnce(ctx.caller.runId, async () => [...(await doctorAll(ctx, kind)), ...(await own())]);
  if (name === undefined) {
    const all = await Promise.all((await entries(ctx, kind)).map((e) => checkOne(ctx, e)));
    return [...all, ...(await own())];
  }
  return doctorOne(ctx, kind, name, own);
}

/** One by name: ion's, else (a connection) an agent's own of that name, else the plain "not found". */
async function doctorOne(
  ctx: Ctx,
  kind: ToolType,
  name: string,
  own: () => Promise<ToolCheck[]>,
): Promise<ToolCheck[]> {
  const e = await entry(ctx, kind, name).catch(async (err: unknown) => {
    if (kind === "mcp" && (await own()).length) return null;
    throw err;
  });
  return e ? [await checkOne(ctx, e)] : own();
}

/** Every one, one at a time (each may start a server or run a hook). */
async function doctorAll(ctx: Ctx, kind: ToolType): Promise<ToolCheck[]> {
  const out: ToolCheck[] = [];
  for (const e of await entries(ctx, kind)) out.push(await checkOne(ctx, e));
  return out;
}

/** When each run last asked doctor for every one: at most once per this long (Task review, 2026-11-21). */
const lastAll = new Map<string, number>();
const ALL_EVERY_MS = 10_000;

function everyOnce<T>(runId: string, f: () => Promise<T>): Promise<T> {
  const now = Date.now();
  if (now - (lastAll.get(runId) ?? 0) < ALL_EVERY_MS) throw new UserError("Wait a moment");
  lastAll.set(runId, now);
  if (lastAll.size > 1000) lastAll.delete(lastAll.keys().next().value!);
  return f();
}
