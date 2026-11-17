import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { mkdtempSync, realpathSync } from "node:fs";
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
export async function connect(h: AcpHarness, bin: string, cwd: string): Promise<Connection> {
  const child = spawn(bin, h.args, { stdio: ["pipe", "pipe", "ignore"], env: process.env });
  const rpc = createRpc({ stdin: child.stdin, stdout: child.stdout });
  child.on("error", () => child.stdout.destroy());
  try {
    await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "ion", version: "0.0.0" },
    });
    const s = (await rpc.request("session/new", { cwd, mcpServers: [] })) as {
      sessionId: string;
      configOptions?: ConfigOption[];
    };
    return { child, rpc, sessionId: s.sessionId, options: s.configOptions ?? [] };
  } catch (e) {
    child.kill();
    if (e instanceof RpcError && e.code === -32000)
      throw new Error(`${h.label} isn't signed in. Run: ${h.loginHint}`);
    throw e;
  }
}

/** Signed in when the agent opens a session without asking for authentication. Sends no prompt. */
export async function probeSignedIn(h: AcpHarness, bin: string): Promise<boolean> {
  try {
    const c = await connect(h, bin, realpathSync(mkdtempSync(join(tmpdir(), "ion-probe-"))));
    c.child.kill();
    return true;
  } catch {
    return false;
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
