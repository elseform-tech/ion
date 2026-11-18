import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { connect as tcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type IonClient } from "@ion/client";
import type { IonEvent } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer } from "./server.js";
import { loadUserConfig, saveUserConfig } from "@ion/config";

const repo = (name: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "ion-repo-")), name);
  mkdirSync(p, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: p });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
  return p;
};

describe("daemon api", () => {
  let home: string;
  let srv: Awaited<ReturnType<typeof startServer>>;
  let client: IonClient;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "ion-home-"));
    srv = await startServer({ dataDir: join(home, "data"), configFile: join(home, "config.toml"), port: 0 });
    client = await connect({ port: srv.port, token: srv.token });
  });
  afterEach(async () => {
    client.close();
    await srv.close();
  });

  const refused = (ws: WebSocket) =>
    new Promise<number>((r) => ws.on("unexpected-response", (_req, res) => r(res.statusCode ?? 0)));

  it("refuses a wrong token at the handshake", async () => {
    expect(await refused(new WebSocket(`ws://127.0.0.1:${srv.port}/`, ["ion", "ion.token.wrong"]))).toBe(401);
  });

  it("doesn't accept the token in the URL", async () => {
    expect(await refused(new WebSocket(`ws://127.0.0.1:${srv.port}/?token=${srv.token}`))).toBe(401);
  });

  // Regression (final review C1): a malformed frame used to crash the daemon.
  it("survives a malformed frame from an authenticated socket", async () => {
    const sock = tcp(srv.port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    sock.write(
      "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
        `Sec-WebSocket-Protocol: ion, ion.token.${srv.token}\r\n\r\n`,
    );
    await new Promise((r) => sock.once("data", r));
    sock.write(Buffer.from([0x83, 0x80, 1, 2, 3, 4])); // reserved opcode
    await new Promise((r) => setTimeout(r, 100));
    sock.destroy();
    expect(await client.call("status", {})).toMatchObject({ projects: 0 });
  });

  // Plan 06: needs are agents' questions, answered by number with a scope.
  it("answers questions only with a known scope and a known need", async () => {
    await expect(
      client.call("need.answer", { needId: "x", choice: 1, scope: "always" } as never),
    ).rejects.toThrow("Pick chat, project or everywhere");
    await expect(client.call("need.answer", { needId: "x", choice: 1 })).rejects.toThrow("Unknown need: x");
  });

  // Plan 06 (RF3): an agent asks over MCP, the run ends, you answer, and the answer starts the next run.
  it("carries your answer to an agent's question into the chat's next run", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    await client.call("projects.add", { path: repo("app") });
    const seen: IonEvent[] = [];
    await client.subscribe({}, (e) => seen.push(e));
    const { chatId, runId } = await client.call("ask", { text: "asks", harness: "fake", projectId: "app" });
    await until(() => seen.some((e) => e.runId === runId && e.type === "run.finished"), 5000);
    const [need] = await client.call("needs.list", { chatId });
    expect(need).toMatchObject({ kind: "ask", summary: "Merge it?" });
    await client.call("need.answer", { needId: need!.needId, choice: 2, scope: "project" });
    await until(() => seen.some((e) => e.type === "message.sent" && e.runId !== runId), 5000);
    const sent = seen.filter((e) => e.type === "message.sent").at(-1)!;
    expect(sent).toMatchObject({ chatId, data: { text: 'You asked: "Merge it?". The user chose: "Wait".' } });
    await until(() => seen.some((e) => e.type === "decision.outcome"), 5000);
    expect(await client.call("decisions.list", {})).toMatchObject([
      { choice: "Wait", scope: "project", outcomes: [{ kind: "ran" }] },
    ]);
  });

  it("serves ion's MCP server on the same port, only with a run's key", async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/mcp`, { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${srv.port}/other`)).status).toBe(404);
    // The daemon's own token is not an MCP key.
    const own = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${srv.token}` },
      body: "{}",
    });
    expect(own.status).toBe(401);
  });

  it("closes sockets that send oversized messages", async () => {
    const big = await connect({ port: srv.port, token: srv.token });
    await expect(big.call("projects.add", { path: "x".repeat(2 * 1024 * 1024) })).rejects.toThrow(
      "Connection closed",
    );
    expect(await client.call("status", {})).toMatchObject({ projects: 0 });
  });

  it("tightens a data folder that already existed with loose permissions", async () => {
    const h = mkdtempSync(join(tmpdir(), "ion-loose-"));
    mkdirSync(join(h, "data"), { mode: 0o755 });
    const s2 = await startServer({ dataDir: join(h, "data"), configFile: join(h, "config.toml"), port: 0 });
    await s2.close();
    expect(statSync(join(h, "data")).mode & 0o777).toBe(0o700);
  });

  // Regression (final review I7): a run left open by a crash is closed on the next start.
  it("marks runs a crash left unfinished as failed on start", async () => {
    const h = mkdtempSync(join(tmpdir(), "ion-sweep-"));
    const { openDb, EventStore } = await import("../store/index.js");
    const { allViews } = await import("../views/index.js");
    mkdirSync(join(h, "data"), { recursive: true });
    const db = openDb(join(h, "data", "ion.db"));
    new EventStore(db, allViews).append({
      chatId: "c",
      runId: "r-crashed",
      origin: "adapter",
      type: "run.started",
      data: { harness: "fake", model: "m", effort: null, authMethod: null },
    });
    db.close();
    const s2 = await startServer({ dataDir: join(h, "data"), configFile: join(h, "config.toml"), port: 0 });
    const c2 = await connect({ port: s2.port, token: s2.token });
    const seen: IonEvent[] = [];
    await c2.subscribe({ chatId: "c" }, (e) => seen.push(e));
    await until(() => seen.some((e) => e.type === "run.finished"));
    expect(seen.at(-1)).toMatchObject({ type: "run.finished", data: { status: "failed" } });
    c2.close();
    await s2.close();
  });

  it("keeps its data folder private", () => {
    expect(statSync(join(home, "data")).mode & 0o777).toBe(0o700);
  });

  it("reports status", async () => {
    const s = await client.call("status", {});
    expect(s).toMatchObject({ projects: 0, configError: null, pid: process.pid });
  });

  it("adds a project and saves it to the config file", async () => {
    const p = repo("storefront");
    expect(await client.call("projects.add", { path: p })).toEqual({
      id: "storefront",
      path: p,
      starred: false,
    });
    expect(await client.call("projects.list", {})).toHaveLength(1);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(p);
  });

  it("rejects a folder that isn't a git repo", async () => {
    await expect(client.call("projects.add", { path: "/nope" })).rejects.toThrow(
      "Not a git repository: /nope",
    );
  });

  it("answers unknown commands with unknown_command", async () => {
    await expect(client.call("does.not.exist" as never, {} as never)).rejects.toMatchObject({
      code: "unknown_command",
    });
  });

  it("rejects a subscription from an unknown event id and keeps serving", async () => {
    await expect(client.subscribe({ afterId: "01JDNOPE" }, () => {})).rejects.toMatchObject({
      code: "invalid",
    });
    expect(await client.call("status", {})).toMatchObject({ projects: 0 });
  });

  it("runs an ask end to end and keeps serving after a failed run", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    const repoPath = repo("app");
    await client.call("projects.add", { path: repoPath });
    const seen: IonEvent[] = [];
    await client.subscribe({}, (e) => seen.push(e));
    const { runId } = await client.call("ask", { text: "fail", projectId: "app", harness: "fake" });
    await until(() => seen.some((e) => e.runId === runId && e.type === "run.finished"));
    expect(seen.filter((e) => e.runId === runId).at(-1)?.data).toEqual({ status: "failed" });
    expect(await client.call("status", {})).toMatchObject({ projects: 1 });
    await expect(client.call("ask", { text: "  ", projectId: "app", harness: "fake" })).rejects.toThrow(
      "Say what to do",
    );
  });

  it("pushes events to subscribers, and only later ones after afterId", async () => {
    const seen: IonEvent[] = [];
    await client.subscribe({}, (e) => seen.push(e));
    const first = await client.call("chat.create", { title: "One" });
    await until(() => seen.length === 1);
    expect(seen[0]).toMatchObject({
      type: "chat.created",
      origin: "daemon",
      data: { title: "One", projectId: null },
    });

    await client.call("chat.create", { title: "Two" });
    const later: IonEvent[] = [];
    await client.subscribe({ afterId: first.id }, (e) => later.push(e));
    await until(() => later.length === 1);
    expect(later.map((e) => (e.data as { title: string }).title)).toEqual(["Two"]);
  });

  // Plan 07: the changes panel.
  it("shows a chat's changes, and none once it's archived", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    await client.call("projects.add", { path: repo("app") });
    const seen: IonEvent[] = [];
    await client.subscribe({}, (e) => seen.push(e));
    const { chatId, runId } = await client.call("ask", { text: "edit", harness: "fake", projectId: "app" });
    await until(() => seen.some((e) => e.runId === runId && e.type === "run.finished"), 5000);
    const { files } = await client.call("chat.diff", { chatId });
    expect(files.map((f) => [f.path, f.added])).toEqual([["notes.md", 1]]);
    await client.call("chat.archive", { chatId });
    expect((await client.call("chat.diff", { chatId })).files).toEqual([]);
    await expect(client.call("chat.diff", { chatId: "nope" })).rejects.toThrow("Unknown chat: nope");
  });

  // Plan 09: ion chief and one ion per project; default has none.
  it("lists ion chief, then each project's ion", async () => {
    await client.call("projects.add", { path: repo("app") });
    const ions = await client.call("ions.list", {});
    expect(ions.map((x) => [x.ionId, x.name])).toEqual([
      ["chief", "ion"],
      ["app", "app"],
    ]);
  });

  it("starts a thread when you message a project's ion, and ion chief routes with the fake model", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    await client.call("projects.add", { path: repo("app") });
    const seen: IonEvent[] = [];
    await client.subscribe({}, (e) => seen.push(e));
    // ion chief's model is the judge's: the fake one here (never a real model in tests).
    const cf = join(home, "config.toml");
    const { config } = loadUserConfig(cf);
    saveUserConfig(cf, { ...config, access: { ...config.access, judge: "fake" } });
    await client.call("ion.message", { ionId: "app", text: "hello from your ion" });
    const thread = (await client.call("chats.list", {})).find((c) => c.by === "ion");
    expect(thread).toMatchObject({ projectId: "app", title: "hello from your ion" });
    await until(
      () =>
        seen.some(
          (e) =>
            e.chatId === "ion:app" &&
            e.type === "ion.said" &&
            (e.data as { text: string }).text.startsWith("hello from your ion: done"),
        ),
      5000,
    );
    await client.call("ion.message", { ionId: "chief", text: "please check app" });
    await until(() => seen.some((e) => e.chatId === "ion:chief" && e.type === "ion.said"), 15_000);
    const chief = seen.filter((e) => e.chatId === "ion:chief" && e.type === "ion.said").at(-1)!.data as {
      text: string;
    };
    expect(chief).toMatchObject({ text: "", card: { kind: "threads" } });
    // Two runs end to end (a thread, then ion chief routing): slower than 5 s when the whole suite runs at once.
  }, 20_000);

  // The user, 2026-11-18: chats can be renamed from the sidebar.
  it("renames a chat, and refuses an empty name or an unknown chat", async () => {
    const { chatId } = await client.call("chat.create", { title: "Old name" });
    await client.call("chat.rename", { chatId, title: "  Checkout rounding  " });
    expect((await client.call("chats.list", {})).find((c) => c.chatId === chatId)?.title).toBe(
      "Checkout rounding",
    );
    await expect(client.call("chat.rename", { chatId, title: "  " })).rejects.toThrow("Give the chat a name");
    await expect(client.call("chat.rename", { chatId: "nope", title: "x" })).rejects.toThrow(
      "Unknown chat: nope",
    );
  });

  // Plan 07: the app's sidebar wants only what happens from now on, not every event ion ever stored.
  it("sends no backlog with fromNow", async () => {
    await client.call("chat.create", { title: "Old" });
    const seen: IonEvent[] = [];
    await client.subscribe({ fromNow: true }, (e) => seen.push(e));
    await client.call("chat.create", { title: "New" });
    await until(() => seen.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.map((e) => (e.data as { title: string }).title)).toEqual(["New"]);
  });
});

async function until(f: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
