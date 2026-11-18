import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type IonClient } from "@ion/client";
import { addProject, DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import type { IonEvent } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer } from "../api/server.js";
import { createGrants, createMcpHandler, type Grants } from "../mcp/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { createGateHandler } from "./index.js";
import { readJson } from "./server.js";

process.env.ION_ALLOW_FAKE = "1";

async function until(f: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("the gate, end to end with the fake harness", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let client: IonClient;

  beforeEach(async () => {
    const home = mkdtempSync(join(tmpdir(), "ion-gate-"));
    const repo = join(home, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync(
      "git",
      ["-c", "user.email=t@e.x", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "i"],
      {
        cwd: repo,
      },
    );
    const configFile = join(home, "config.toml");
    const c = addProject(DEFAULT_CONFIG, repo);
    saveUserConfig(configFile, { ...c, access: { default: "auto", judge: "fake" } });
    srv = await startServer({ dataDir: join(home, "data"), configFile, port: 0 });
    client = await connect({ port: srv.port, token: srv.token });
  });
  afterEach(async () => {
    client.close();
    await srv.close();
  });

  /** Runs a gated command and returns the run's approval records. */
  async function run(command: string, access: "auto" | "full" = "auto") {
    const seen: IonEvent[] = [];
    await client.subscribe({}, (e) => seen.push(e));
    const { runId } = await client.call("ask", {
      text: `gated ${command}`,
      harness: "fake",
      projectId: "repo",
      access,
    });
    await until(() => seen.some((e) => e.runId === runId && e.type === "run.finished"));
    const mine = seen.filter((e) => e.runId === runId);
    const said = mine
      .filter((e) => e.type === "message.completed")
      .map((e) => String((e.data as { text: string }).text));
    const records = mine
      .filter((e) => e.type === "approval.resolved")
      .map((e) => e.data as Record<string, unknown>);
    return Object.assign(records, { said });
  }

  it("denies a secret in Auto at the gate, says to ask, and doesn't queue the deny", async () => {
    const records = await run("cat ~/.ssh/id_rsa");
    const gate = records.find((r) => String(r.requestId).startsWith("g"));
    expect(gate).toMatchObject({
      decision: "deny",
      by: "ion",
      summary: "cat ~/.ssh/id_rsa",
      reason: "Touches your secrets",
    });
    // The agent is told the way through: asking you.
    expect(records.said).toEqual([
      "Blocked: Touches your secrets — if it's needed, ask the user with ion's ask tool",
    ]);
    // The harness's own permission prompt after a gate deny is decided in full, never from the queue.
    expect(records.find((r) => !String(r.requestId).startsWith("g"))).toMatchObject({
      decision: "deny",
      by: "ion",
    });
  });

  it("answers the harness's own prompt from the gate's allow: one record from ion", async () => {
    const records = await run("cat /etc/hosts");
    expect(records.filter((r) => r.by === "ion")).toHaveLength(1);
    expect(records.find((r) => !String(r.requestId).startsWith("g"))).toMatchObject({
      decision: "allow",
      by: "gate",
    });
  });

  it("stores nothing from the gate in Full access", async () => {
    const records = await run("ls", "full");
    expect(records.filter((r) => String(r.requestId).startsWith("g"))).toEqual([]);
  });

  it("decides a prompt in full when the gate never saw the call", async () => {
    const seen: IonEvent[] = [];
    await client.subscribe({}, (e) => seen.push(e));
    const { runId } = await client.call("ask", { text: "shell", harness: "fake", projectId: "repo" });
    await until(() => seen.some((e) => e.runId === runId && e.type === "run.finished"));
    const r = seen.find((e) => e.runId === runId && e.type === "approval.resolved");
    expect(r?.data).toMatchObject({ decision: "allow", by: "ion" });
  });
});

describe("gate keys", () => {
  let http: Server;
  let base: string;
  let grants: Grants;
  let db: Db;

  beforeEach(async () => {
    db = openDb(":memory:");
    const store = new EventStore(db, allViews);
    grants = createGrants();
    const gate = createGateHandler({ grants, decide: async () => ({ decision: "allow" }) });
    const mcp = createMcpHandler({ store, db, grants });
    http = createServer((req, res) => {
      if (req.url?.startsWith("/gate/")) void gate(req, res);
      else void mcp(req, res);
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const addr = http.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterEach(() => {
    http.close();
    db.close();
  });

  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", ...headers },
    });

  it("answers only a live gate key, never from a browser, and keys don't cross", async () => {
    const scope = { projectId: "app", chatId: "c1", runId: "r1" };
    const gateKey = grants.create(scope, "gate");
    const mcpKey = grants.create(scope);
    expect((await post(`/gate/${gateKey}`)).status).toBe(200);
    expect(await (await post(`/gate/${gateKey}`)).json()).toEqual({ decision: "allow" });
    expect((await post(`/gate/${"0".repeat(64)}`)).status).toBe(401);
    expect((await post(`/gate/${gateKey}`, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(`/gate/${mcpKey}`)).status).toBe(401);
    expect((await post("/mcp", { authorization: `Bearer ${gateKey}` })).status).toBe(401);
    grants.revoke("r1");
    expect((await post(`/gate/${gateKey}`)).status).toBe(401);
  });

  it("is a 400 (a deny, for the hook) when the call can't be read", async () => {
    grants = createGrants();
    const key = grants.create({ projectId: "app", chatId: "c1", runId: "r1" }, "gate");
    const gate = createGateHandler({ grants, decide: async () => null });
    const one = createServer((req, res) => void gate(req, res));
    await new Promise<void>((r) => one.listen(0, "127.0.0.1", r));
    const addr = one.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const r = await fetch(`http://127.0.0.1:${port}/gate/${key}`, { method: "POST", body: "{}" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ decision: "deny", reason: "ion couldn't read this tool call" });
    one.close();
  });
});

describe("gate body", () => {
  // Security review: a body over the cap used to leave the read waiting forever.
  it("settles when the body is too large and the request is torn down", async () => {
    const { EventEmitter } = await import("node:events");
    const req = Object.assign(new EventEmitter(), {
      destroy() {
        queueMicrotask(() => this.emit("close"));
      },
    });
    const read = readJson(req as never);
    req.emit("data", Buffer.alloc(2 * 1024 * 1024));
    expect(await Promise.race([read, new Promise((r) => setTimeout(() => r("hung"), 200))])).toBeUndefined();
  });
});
