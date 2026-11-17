import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Catalog, ResumeFailed, type StartOpts } from "@ion/adapter-kit";
import type { AcpHarness } from "./harnesses.js";
import { createRpc, type Rpc, RpcError } from "./rpc.js";

type Choice = { value?: unknown; name?: unknown; options?: Choice[] };
type ConfigOption = { id: string; category?: string; currentValue?: unknown; options?: Choice[] };
export type Connection = {
  child: ChildProcessByStdio<Writable, Readable, null>;
  rpc: Rpc;
  sessionId: string;
  options: ConfigOption[];
};

/** Spawns the agent (never through a shell), initializes ACP and opens a session in `cwd`. */
export type ConnectOpts = {
  cwd: string;
  timeoutMs?: number;
  resume?: string | null;
  mcp?: StartOpts["mcp"];
};

export async function connect(h: AcpHarness, bin: string, o: ConnectOpts): Promise<Connection> {
  const timeoutMs = o.timeoutMs ?? 30_000;
  const child = spawn(bin, h.args, {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, ...(h.env?.() ?? {}) },
  });
  const rpc = createRpc({ stdin: child.stdin, stdout: child.stdout });
  child.on("error", () => child.stdout.destroy());
  child.on("exit", () => child.stdout.destroy());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NotResponding(`${h.label} didn't respond`)), timeoutMs);
  });
  try {
    return await Promise.race([handshake(h, { rpc, child }, o), timeout]);
  } catch (e) {
    child.kill();
    if (e instanceof RpcError && e.code === -32000)
      throw new Error(`${h.label} isn't signed in. Run: ${h.loginHint}`);
    if (o.resume && e instanceof RpcError)
      throw new ResumeFailed(`${h.label} couldn't continue this chat's session`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** The agent didn't answer in time (first-run download, an interactive prompt, a hang). */
class NotResponding extends Error {}

type AgentCaps = { loadSession?: boolean; sessionCapabilities?: { resume?: object } };

async function handshake(
  h: AcpHarness,
  io: Pick<Connection, "rpc" | "child">,
  o: ConnectOpts,
): Promise<Connection> {
  const init = (await io.rpc.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "ion", version: "0.0.0" },
  })) as { agentCapabilities?: AgentCaps };
  const mcpServers = o.mcp
    ? [
        {
          type: "http",
          name: o.mcp.name,
          url: o.mcp.url,
          headers: Object.entries(o.mcp.headers).map(([name, value]) => ({ name, value })),
        },
      ]
    : [];
  const base = { cwd: o.cwd, mcpServers, ...(h.sessionMeta ? { _meta: h.sessionMeta } : {}) };
  if (o.resume) {
    const method = continueMethod(init.agentCapabilities ?? {});
    if (!method) throw new ResumeFailed(`${h.label} can't continue sessions`);
    // session/load replays the old conversation as updates; nothing listens yet, so it isn't shown again.
    const r = (await io.rpc.request(method, { ...base, sessionId: o.resume })) as {
      configOptions?: ConfigOption[];
    };
    return { ...io, sessionId: o.resume, options: r?.configOptions ?? [] };
  }
  const s = (await io.rpc.request("session/new", base)) as {
    sessionId: string;
    configOptions?: ConfigOption[];
  };
  return { ...io, sessionId: s.sessionId, options: s.configOptions ?? [] };
}

/** session/resume when the agent offers it (no replay), else session/load, else none. */
function continueMethod(caps: AgentCaps): "session/resume" | "session/load" | null {
  if (caps.sessionCapabilities?.resume) return "session/resume";
  return caps.loadSession ? "session/load" : null;
}

/** Opens a session without sending a prompt: signed in, signed out, or not responding. Cleans up after itself. */
export async function probeSignedIn(
  h: AcpHarness,
  bin: string,
  timeoutMs?: number,
): Promise<"yes" | "no" | "not-responding"> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ion-probe-")));
  try {
    const c = await connect(h, bin, { cwd: dir, timeoutMs });
    c.child.kill();
    return "yes";
  } catch (e) {
    return e instanceof NotResponding ? "not-responding" : "no";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The agent's models: the choices of its model option (groups flattened), from a session opened without a prompt. */
export async function probeModels(h: AcpHarness, bin: string, timeoutMs?: number): Promise<Catalog> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ion-probe-")));
  try {
    const c = await connect(h, bin, { cwd: dir, timeoutMs });
    c.child.kill();
    const opt = c.options.find((o) => o.category === "model");
    const flat = (cs: Choice[]): Choice[] =>
      cs.flatMap((x) => (Array.isArray(x.options) ? flat(x.options) : [x]));
    const models = flat(opt?.options ?? [])
      .filter((x) => typeof x.value === "string")
      .map((x) => ({ id: String(x.value), label: typeof x.name === "string" ? x.name : String(x.value) }));
    const current = typeof opt?.currentValue === "string" ? opt.currentValue : null;
    return { models, defaultModel: h.defaultModel ?? current };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Sets a session config option of the given category (model, thought_level) when the agent offers one. */
export async function setOption(
  c: Connection,
  category: string,
  value: string | null,
): Promise<string | null> {
  const opt = c.options.find((o) => o.category === category);
  if (!opt) return null;
  if (value) {
    await c.rpc
      .request("session/set_config_option", { sessionId: c.sessionId, configId: opt.id, value })
      .catch(() => {});
    return value;
  }
  return typeof opt.currentValue === "string" ? opt.currentValue : null;
}
