import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpHarness } from "./harnesses.js";
import { createRpc, type Rpc, RpcError } from "./rpc.js";

type ConfigOption = { id: string; category?: string; currentValue?: unknown };
export type Connection = {
  child: ChildProcessByStdio<Writable, Readable, null>;
  rpc: Rpc;
  sessionId: string;
  options: ConfigOption[];
};

/** Spawns the agent (never through a shell), initializes ACP and opens a session in `cwd`. */
export async function connect(
  h: AcpHarness,
  bin: string,
  cwd: string,
  timeoutMs = 30_000,
): Promise<Connection> {
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
    return await Promise.race([handshake(h, rpc, child, cwd), timeout]);
  } catch (e) {
    child.kill();
    if (e instanceof RpcError && e.code === -32000)
      throw new Error(`${h.label} isn't signed in. Run: ${h.loginHint}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** The agent didn't answer in time (first-run download, an interactive prompt, a hang). */
class NotResponding extends Error {}

async function handshake(
  h: AcpHarness,
  rpc: Rpc,
  child: Connection["child"],
  cwd: string,
): Promise<Connection> {
  {
    await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "ion", version: "0.0.0" },
    });
    const s = (await rpc.request("session/new", {
      cwd,
      mcpServers: [],
      ...(h.sessionMeta ? { _meta: h.sessionMeta } : {}),
    })) as {
      sessionId: string;
      configOptions?: ConfigOption[];
    };
    return { child, rpc, sessionId: s.sessionId, options: s.configOptions ?? [] };
  }
}

/** Opens a session without sending a prompt: signed in, signed out, or not responding. Cleans up after itself. */
export async function probeSignedIn(
  h: AcpHarness,
  bin: string,
  timeoutMs?: number,
): Promise<"yes" | "no" | "not-responding"> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ion-probe-")));
  try {
    const c = await connect(h, bin, dir, timeoutMs);
    c.child.kill();
    return "yes";
  } catch (e) {
    return e instanceof NotResponding ? "not-responding" : "no";
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
