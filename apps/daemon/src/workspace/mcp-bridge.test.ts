import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type GateCall, type RunSandbox, sandboxKind } from "@ion/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGateway } from "../gateway/index.js";
import { createGrants } from "../mcp/index.js";
import { redactor } from "../runs/servers.js";
import { bridgesFor, type RunBridges } from "./mcp-bridge.js";

// The user, 2026-11-20 (asked for ion as the gateway, "In Plan 18 now"): ion runs your local MCP servers itself, for
// each chat's run, and serves them through its gateway, so agents never start them or see their env.

const TINY = fileURLToPath(new URL("./fixtures/tiny-mcp.mjs", import.meta.url));
const spec = (env: Record<string, string> = {}, name = "tiny") => ({
  name,
  transport: "stdio" as const,
  command: process.execPath,
  args: [TINY],
  env,
});

const open: RunBridges[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.close()));
});

type Extra = {
  over?: Partial<ReturnType<typeof spec>>;
  redact?: <T>(d: T) => T;
  groups?: string;
  sandbox?: (data: string) => RunSandbox;
};

function bridge(env: Record<string, string> = {}, x: Extra = {}) {
  const worktree = mkdtempSync(join(tmpdir(), "ion-bridge-wt-"));
  const data = realpathSync(mkdtempSync(join(tmpdir(), "ion-bridge-data-")));
  const folder = join(data, "mcp-run", "run-1");
  const stopped: string[] = [];
  const b = bridgesFor([{ ...spec(env), ...x.over }], {
    folder,
    worktree,
    stopped: (name, why) => stopped.push(`${name} ${why}`),
    ...(x.redact ? { redact: x.redact } : {}),
    ...(x.groups ? { groups: x.groups } : {}),
    ...(x.sandbox ? { sandbox: x.sandbox(data) } : {}),
  });
  open.push(b);
  return { b, stopped, folder, worktree, data };
}

type Answer = {
  id?: unknown;
  result?: { content?: { text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
};

const send = async (b: RunBridges, method: string, params: object = {}, id = 1) =>
  (await b.get("tiny")!.send({ jsonrpc: "2.0", id, method, params })) as Answer;
const tool = async (b: RunBridges, name: string, args: object = {}) =>
  send(b, "tools/call", { name, arguments: args });
const said = (a: Answer) => JSON.parse(a.result!.content![0]!.text) as Record<string, unknown>;

type Who = { pid: number; ppid: number; cwd: string; env: Record<string, string> };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("ion's bridge to your local MCP servers", () => {
  // Final review, 2026-11-21: servers started in the chat's worktree, so a `.npmrc`, `node_modules/<pkg>`, `x.py`
  // or relative script the agent planted there ran as ion's child holding your key.
  it("a stdio server is started by ion with its env, in an empty folder ion owns (never the worktree)", async () => {
    const { b, folder, worktree } = bridge({ TINY_KEY: "filled-value-1" });
    const who = said(await tool(b, "whoami")) as Who;
    expect(who.ppid).toBe(process.pid);
    expect(realpathSync(who.cwd)).toBe(realpathSync(folder));
    expect(realpathSync(who.cwd)).not.toBe(realpathSync(worktree));
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(who.env.PWD).toBe(folder);
    expect(who.env.INIT_CWD).toBeUndefined();
    expect(who.env.TINY_KEY).toBe("filled-value-1");
    await b.close();
    expect(existsSync(folder)).toBe(false);
  });

  // Security review, 2026-11-21: a repo's server you allowed ran from the chat's worktree, where the agent can
  // rewrite its code after you said yes and ion would run it outside the agent's gate. It runs from the project's own
  // folder (the checkout ion read its .mcp.json from, which chats don't write); yours still run from ion's folder.
  it("a repo's server you allowed for this chat runs from the project folder, never the worktree", async () => {
    const project = mkdtempSync(join(tmpdir(), "ion-bridge-proj-"));
    const { b, worktree } = bridge({}, { over: { cwd: project } });
    const who = said(await tool(b, "whoami")) as Who;
    expect(realpathSync(who.cwd)).toBe(realpathSync(project));
    expect(realpathSync(who.cwd)).not.toBe(realpathSync(worktree));
    expect(who.env.PWD).toBe(project);
  });

  it("a relative script or module planted in the worktree never runs", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "ion-bridge-mark-")), "ran");
    const js = bridge({}, { over: { args: ["x.js"] } });
    writeFileSync(join(js.worktree, "x.js"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "js")`);
    const py = bridge({}, { over: { command: "python3", args: ["-m", "x"] } });
    writeFileSync(join(py.worktree, "x.py"), `open(${JSON.stringify(marker)}, "w").write("py")`);
    expect((await send(js.b, "tools/list")).error?.code).toBe(-32000);
    expect((await send(py.b, "tools/list")).error?.code).toBe(-32000);
    expect(existsSync(marker)).toBe(false);
  });

  it("an .npmrc planted in the worktree is never read", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "ion-bridge-npm-")), "got");
    const script = 'npm config get ion-planted > "$OUT"; exec "$NODE" "$TINY"';
    const env = { OUT: out, NODE: process.execPath, TINY };
    const { b, worktree } = bridge(env, { over: { command: "/bin/sh", args: ["-c", script] } });
    writeFileSync(join(worktree, ".npmrc"), "ion-planted=yes\n");
    expect((await send(b, "tools/list")).result).toHaveProperty("tools");
    expect(readFileSync(out, "utf8").trim()).not.toBe("yes");
  }, 20_000);

  it("${ION_WORKTREE} in a server's args is the chat's folder", async () => {
    const { b, worktree } = bridge({ W: "${ION_WORKTREE}" }, { over: { args: [TINY, "${ION_WORKTREE}"] } });
    const who = said(await tool(b, "whoami")) as Who & { argv: string[] };
    expect(who.argv.at(-1)).toBe(worktree);
    expect(who.env.W).toBe(worktree);
  });

  it("the server's env holds only standard vars and its own filled values", async () => {
    process.env.ION_TEST_BRIDGE_LEAK = "leak-value-123";
    try {
      const { b } = bridge({ TINY_KEY: "filled-value-2" });
      const env = (said(await tool(b, "whoami")) as Who).env;
      expect(env.ION_TEST_BRIDGE_LEAK).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
      // Task review, 2026-11-21: a smaller list than the agents' (no agent config folders, no SSH_AUTH_SOCK).
      // (macOS adds __CF_USER_TEXT_ENCODING to every process itself.)
      const names =
        "PATH HOME USER LOGNAME SHELL TMPDIR TMP TEMP LANG TERM PWD TINY_KEY __CF_USER_TEXT_ENCODING";
      const proxy = /^(https?|no)_proxy$/i;
      const ok = (k: string) => names.split(" ").includes(k) || k.startsWith("LC_") || proxy.test(k);
      expect(Object.keys(env).filter((k) => !ok(k))).toEqual([]);
    } finally {
      delete process.env.ION_TEST_BRIDGE_LEAK;
    }
  });

  it("it's stopped when the run ends", async () => {
    const { b } = bridge();
    const { pid } = said(await tool(b, "whoami")) as Who;
    expect(alive(pid)).toBe(true);
    await b.close();
    expect(alive(pid)).toBe(false);
    expect((await tool(b, "echo", { text: "hi" })).error?.message).toMatch(/tiny/);
  });

  it("a crash is said once and the run goes on", async () => {
    const { b, stopped } = bridge();
    expect((await send(b, "tools/list")).result).toHaveProperty("tools");
    const crashed = await tool(b, "crash");
    expect(crashed.error?.message).toBe("tiny stopped, so ion can't reach it");
    const after = await tool(b, "echo", { text: "hi" });
    expect(after.error?.message).toBe("tiny stopped, so ion can't reach it");
    expect(stopped).toEqual(["tiny crash"]);
  });

  it("a server that won't start is said once; requests to it get a JSON-RPC error", async () => {
    const { b, stopped } = bridge({}, { over: { command: "/nonexistent/ion-no-such-server" } });
    expect((await send(b, "tools/list")).error?.code).toBe(-32000);
    // Task review, 2026-11-21: one that never started says so, not "stopped".
    expect((await send(b, "tools/list", {}, 2)).error?.message).toBe(
      "tiny couldn't start, so ion can't reach it",
    );
    expect(stopped).toEqual(["tiny start"]);
  });

  it("two runs get their own server processes", async () => {
    const one = bridge();
    const two = bridge();
    const a = said(await tool(one.b, "whoami")) as Who;
    const b = said(await tool(two.b, "whoami")) as Who;
    expect(a.pid).not.toBe(b.pid);
    await one.b.close();
    expect(alive(a.pid)).toBe(false);
    expect(alive(b.pid)).toBe(true);
  });

  it("a server-initiated request is refused", async () => {
    const { b } = bridge();
    expect(said(await tool(b, "roots"))).toMatchObject({ code: -32601 });
  });

  it("answers the agent's handshake with the server's own capabilities and name", async () => {
    const { b } = bridge();
    const init = (await send(b, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "agent", version: "1" },
    })) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: object } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo.name).toBe("tiny");
    // Task review, 2026-11-21: only what ion passes on (no list changes, subscriptions or logs).
    expect(init.result.capabilities).toEqual({ tools: {}, resources: {} });
    expect(await b.get("tiny")!.send({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });
});

describe("your local servers through ion's gateway", () => {
  let ion: Server | undefined;
  afterEach(() => ion?.close());

  /** ion's gateway on 127.0.0.1 in front of a run's bridges: POST as the run's agent. */
  async function through(b: RunBridges, decide: () => { decision: "allow" | "deny"; reason?: string }) {
    const grants = createGrants();
    const key = grants.create({ kind: "run", projectId: "p", chatId: "c1", runId: "r1" });
    const gated: GateCall[] = [];
    const gateway = createGateway({
      grants,
      upstream: (runId, name) => (runId === "r1" ? b.get(name) : null),
      gate: async (_r, call) => {
        gated.push(call);
        return decide();
      },
    });
    ion = createServer((req, res) => void gateway.handle(req, res));
    await new Promise<void>((r) => ion!.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(ion.address() as AddressInfo).port}/mcp/s/tiny`;
    const post = async (body: object) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: r.status === 202 ? null : ((await r.json()) as Answer) };
    };
    return { post, gated, url, key };
  }

  it("its tools are reachable through ion and gated with real names", async () => {
    const { b } = bridge();
    let decision: { decision: "allow" | "deny"; reason?: string } = { decision: "allow" };
    const { post, gated, url, key } = await through(b, () => decision);
    const call = (text: string) => ({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "echo", arguments: { text } },
    });

    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).status).toBe(200);
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect(gated).toEqual([]);
    const ok = await post(call("hi"));
    expect(ok.body?.result?.content?.[0]?.text).toBe("hi");
    expect(gated).toEqual([
      { toolName: "echo", kind: "mcp", mcpServer: "tiny", summary: "echo (tiny)", input: { text: "hi" } },
    ]);
    decision = { decision: "deny", reason: "Not this one" };
    const no = await post(call("no"));
    expect(no.body?.result).toEqual({ content: [{ type: "text", text: "Not this one" }], isError: true });
    const get = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
    expect(get.status).toBe(405);
  });
});

// Task review, 2026-11-21: a server's own children outlived the run, a child holding its pipes made stopping take 8 s
// and hid a crash; a pid was signalled after it exited; batches, a server's error text and a huge answer went
// through unchecked; one request at a time per server; a cancelled call kept running.
describe("ion stops your local servers and everything they started", () => {
  // Found 2026-11-28: this counted every `sleep 4242` on the machine, so another run of the suite (or any sleep)
  // made it flaky. The child's sleep now has a time of its own, made from this process's id, and only that one is counted.
  const own = `sleep 7${String(process.pid).padStart(6, "0")}`;
  const withChild = { command: "/bin/sh", args: ["-c", `${own} & exec "${process.execPath}" "${TINY}"`] };
  const sleeps = () => {
    try {
      return execFileSync("pgrep", ["-f", own]).toString().trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };

  it("counts only its own children, with an unrelated sleep running", async () => {
    const other = spawn("sleep", ["4242"], { stdio: "ignore" });
    try {
      const { b } = bridge({}, { over: withChild });
      expect((await send(b, "tools/list")).result).toHaveProperty("tools");
      expect(sleeps()).toHaveLength(1);
      await b.close();
      expect(sleeps()).toHaveLength(0);
    } finally {
      other.kill();
    }
  });

  it("stops a server's own children too, in under 4 s", async () => {
    const before = sleeps().length;
    const { b } = bridge({}, { over: withChild });
    expect((await send(b, "tools/list")).result).toHaveProperty("tools");
    expect(sleeps()).toHaveLength(before + 1);
    const t = Date.now();
    await b.close();
    expect(Date.now() - t).toBeLessThan(4000);
    expect(sleeps()).toHaveLength(before);
  });

  it("records a server's group while it runs, and forgets it once stopped", async () => {
    const groups = join(mkdtempSync(join(tmpdir(), "ion-groups-")), "mcp-groups.json");
    const { b } = bridge({}, { groups, over: withChild });
    const { pid } = said(await tool(b, "whoami")) as Who;
    expect(JSON.parse(readFileSync(groups, "utf8"))).toMatchObject([{ pgid: pid }]);
    await b.close();
    expect(JSON.parse(readFileSync(groups, "utf8"))).toEqual([]);
  });

  it("a crash is said even when a child holds its pipes, and the child goes too", async () => {
    const before = sleeps().length;
    const { b, stopped } = bridge({}, { over: withChild });
    expect((await tool(b, "crash")).error?.message).toBe("tiny stopped, so ion can't reach it");
    expect(stopped).toEqual(["tiny crash"]);
    await b.close();
    expect(sleeps()).toHaveLength(before);
  });

  it("never signals a process after it exited, and a failed start isn't stopped twice", async () => {
    const kill = vi.spyOn(process, "kill");
    try {
      // A child holding the pipes kept the old transport from noticing the exit; it signalled the dead pid.
      const { b } = bridge({}, { over: withChild });
      const { pid } = said(await tool(b, "whoami")) as Who;
      await tool(b, "crash");
      kill.mockClear();
      await b.close();
      await b.close();
      const signalled = kill.mock.calls.filter(([p, sig]) => Math.abs(Number(p)) === pid && sig !== 0);
      expect(signalled).toEqual([]);
      const failed = bridge({}, { over: { command: "/nonexistent/ion-no-such-server" } });
      await send(failed.b, "tools/list");
      kill.mockClear();
      await failed.b.close();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  // Task review, 2026-11-21: a server flooding ion without newlines swamped it; now it's stopped and said plainly.
  it("a server that sends too much is stopped and said once", async () => {
    const { b, stopped } = bridge();
    const t = Date.now();
    expect((await tool(b, "flood")).error?.message).toBe("tiny sent too much, so ion stopped it");
    expect(Date.now() - t).toBeLessThan(3000);
    expect(stopped).toEqual(["tiny noisy"]);
  });

  it("a server's error text passes the run's redaction", async () => {
    const { b } = bridge({}, { redact: redactor(["run-secret-12345"]) });
    const failed = await tool(b, "fail", { text: "bad token run-secret-12345 here" });
    expect(failed.error?.message).toContain("•••");
    expect(JSON.stringify(failed)).not.toContain("run-secret-12345");
  });

  it("one request at a time per server", async () => {
    const { b } = bridge();
    const [one, two] = await Promise.all([
      send(b, "tools/call", { name: "sleep", arguments: { ms: 300 } }, 1),
      send(b, "tools/call", { name: "sleep", arguments: { ms: 300 } }, 2),
    ]);
    const [a, c] = [said(one!), said(two!)] as { start: number; end: number }[];
    expect(Math.max(a!.start, c!.start)).toBeGreaterThanOrEqual(Math.min(a!.end, c!.end));
  });

  it("the agent's cancel reaches the server", async () => {
    const { b, worktree } = bridge();
    const marker = join(worktree, "cancelled");
    await send(b, "tools/list");
    const running = send(b, "tools/call", { name: "sleep", arguments: { ms: 5000, marker } }, 7);
    await new Promise((r) => setTimeout(r, 300));
    const t = Date.now();
    await b
      .get("tiny")!
      .send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
    expect((await running).error).toBeDefined();
    expect(Date.now() - t).toBeLessThan(2000);
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
  });
});

describe("ion's gateway checks a local server's traffic like a remote one's", () => {
  let ion: Server | undefined;
  afterEach(() => ion?.close());

  async function at(b: RunBridges) {
    const grants = createGrants();
    const key = grants.create({ kind: "run", projectId: "p", chatId: "c1", runId: "r1" });
    const gateway = createGateway({
      grants,
      upstream: () => b.get("tiny"),
      gate: async () => ({ decision: "allow" }),
    });
    ion = createServer((req, res) => void gateway.handle(req, res));
    await new Promise<void>((r) => ion!.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(ion.address() as AddressInfo).port}/mcp/s/tiny`;
    return async (body: unknown) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await r.json()) as Answer;
    };
  }

  it("refuses a batch", async () => {
    const post = await at(bridge().b);
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    expect((await post([list, { ...list, id: 2 }])).error).toMatchObject({ code: -32600 });
  });

  it("stops a local server whose answer is over the line cap", async () => {
    const post = await at(bridge().b);
    const big = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "big", arguments: { size: 17 * 1024 * 1024 } },
    };
    const r = await post(big);
    expect(r.error?.message).toBe("tiny sent too much, so ion stopped it");
  }, 30_000);

  it("passes a local server's 10 MB answer", async () => {
    const post = await at(bridge().b);
    const r = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "big", arguments: { size: 10 * 1024 * 1024 } },
    });
    expect(r.error).toBeUndefined();
    expect(r.result).toBeDefined();
  }, 30_000);
});

// The user, 2026-11-21 (Plan 18 Task 12): ion's local servers run in the OS sandbox too, away from ion's folders
// (they get their values through their env), in their own folder.
describe.skipIf(sandboxKind() !== "seatbelt")("a local server in the sandbox", () => {
  it("can't read ion's folders; its own folder and the project it can", async () => {
    const sandbox = (data: string): RunSandbox => ({
      kind: "seatbelt",
      paths: { deny: [data], read: [], write: [], noWrite: [] },
      dataDir: data,
    });
    const { b, data, folder, worktree } = bridge({}, { sandbox });
    writeFileSync(join(data, "daemon.json"), "full-token\n");
    writeFileSync(join(worktree, "p.txt"), "project\n");
    const read = async (path: string) => (await tool(b, "read", { path })).result!.content![0]!.text;
    expect(await read(join(data, "daemon.json"))).toBe("failed: EPERM");
    expect(await read(join(worktree, "p.txt"))).toBe("project\n");
    expect(said(await tool(b, "whoami")).cwd).toBe(folder);
  });
});
