import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { connect as tcp, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type IonClient } from "@ion/client";
import type { IonEvent } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { getHarness } from "../adapters/registry.js";
import { startServer } from "./server.js";
import { loadUserConfig, saveUserConfig } from "@ion/config";
import { Decisions } from "../decisions/index.js";
import { Ions } from "../ions/service.js";
import { Suggestions } from "../ions/suggestions.js";
import { RunManager } from "../runs/manager.js";
import { Routines } from "../scheduler/index.js";

const repo = (name: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "ion-repo-")), name);
  mkdirSync(p, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: p });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
  // ion keeps a folder's real path (review of Plan 21 Task 2, 2026-11-23): /tmp is /private/tmp on macOS.
  return realpathSync.native(p);
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
    expect(need).toMatchObject({ kind: "ask", summary: "Should I merge the cart drawer fix into main now?" });
    await client.call("need.answer", { needId: need!.needId, choice: 2, scope: "project" });
    await until(() => seen.some((e) => e.type === "message.sent" && e.runId !== runId), 5000);
    const sent = seen.filter((e) => e.type === "message.sent").at(-1)!;
    expect(sent).toMatchObject({
      chatId,
      data: {
        text: `You asked: "Should I merge the cart drawer fix into main now?". The user chose: "Wait until you've tried it yourself".`,
      },
    });
    await until(() => seen.some((e) => e.type === "decision.outcome"), 5000);
    expect(await client.call("decisions.list", {})).toMatchObject([
      { choice: "Wait until you've tried it yourself", scope: "project", outcomes: [{ kind: "ran" }] },
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

  // Task review, 2026-11-19: ions watched their threads before ion listened, so a report turn for a run a crash left
  // unfinished could get ion's tools at port 0. Its ion now reports it through its tools, once ion listens.
  it("reports an ion thread a crash left unfinished, through its ion's tools", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    const h = mkdtempSync(join(tmpdir(), "ion-sweep-"));
    const { openDb, EventStore } = await import("../store/index.js");
    const { allViews } = await import("../views/index.js");
    const { DEFAULT_CONFIG } = await import("@ion/config");
    const cf = join(h, "config.toml");
    saveUserConfig(cf, {
      ...DEFAULT_CONFIG,
      ion: { ...DEFAULT_CONFIG.ion, quick: "fake" },
      projects: [{ id: "app", path: repo("app"), starred: false, harness: "fake" }],
    });
    mkdirSync(join(h, "data"), { recursive: true });
    const db = openDb(join(h, "data", "ion.db"));
    const st = new EventStore(db, allViews);
    const at = { chatId: "c", origin: "daemon" as const };
    st.append({
      ...at,
      runId: null,
      type: "chat.created",
      data: { title: "Fix it", projectId: "app", by: "ion" },
    });
    st.append({
      ...at,
      runId: "r-crashed",
      type: "run.started",
      data: { harness: "fake", model: "m", effort: null, authMethod: null },
    });
    db.close();
    const s2 = await startServer({ dataDir: join(h, "data"), configFile: cf, port: 0 });
    const c2 = await connect({ port: s2.port, token: s2.token });
    const seen: IonEvent[] = [];
    await c2.subscribe({ chatId: "ion:app" }, (e) => seen.push(e));
    // The first look at which agents are ready (each one's CLI) is slow while the whole suite runs.
    await until(() => seen.some((e) => e.type === "ion.said"), 25_000);
    expect(seen.find((e) => e.type === "ion.said")!.data).toEqual({ text: "It didn't finish." });
    expect(seen.some((e) => e.type === "tool.started")).toBe(true);
    c2.close();
    await s2.close();
  }, 30_000);

  // Final review, 2026-11-19: routines started before ion listened, so a routine due at boot got ion's tools at
  // port 0, and the sweep of runs a crash left unfinished then marked its live run failed.
  it("starts a routine due at boot with ion's tools on its port, and doesn't sweep its run", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    const h = mkdtempSync(join(tmpdir(), "ion-boot-"));
    const { openDb, EventStore } = await import("../store/index.js");
    const { allViews } = await import("../views/index.js");
    const { DEFAULT_CONFIG } = await import("@ion/config");
    const cf = join(h, "config.toml");
    const routine = { id: "r1", name: "Check", when: "every 4h", text: "mcpinfo", on: true };
    saveUserConfig(cf, {
      ...DEFAULT_CONFIG,
      projects: [{ id: "app", path: repo("app"), starred: false, harness: "fake", routines: [routine] }],
    });
    mkdirSync(join(h, "data"), { recursive: true });
    const db = openDb(join(h, "data", "ion.db"));
    // It last ran a day ago: a slot came while ion was stopped, so it runs as ion starts.
    const due = new Date(Date.now() - 86_400_000).toISOString();
    new EventStore(db, allViews).append({
      chatId: null,
      runId: null,
      origin: "daemon",
      type: "routine.ran",
      data: { projectId: "app", routineId: "r1", name: "Check", due, by: "schedule", chatId: "old" },
    });
    db.close();
    const s2 = await startServer({ dataDir: join(h, "data"), configFile: cf, port: 0 });
    const c2 = await connect({ port: s2.port, token: s2.token });
    const seen: IonEvent[] = [];
    await c2.subscribe({}, (e) => seen.push(e));
    await until(() => seen.some((e) => e.type === "run.finished" && e.chatId !== "old"), 10_000);
    const said = seen.find((e) => e.type === "message.completed" && e.origin === "adapter");
    const url = String((JSON.parse(String((said?.data as { text: string }).text)) as { url: string }).url);
    expect(url).toBe(`http://127.0.0.1:${s2.port}/mcp`);
    expect(seen.find((e) => e.type === "run.finished")).toMatchObject({ data: { status: "done" } });
    c2.close();
    await s2.close();
  }, 15_000);

  // Final review, 2026-11-19: routines, suggestions and waiting answers started before ion listened (their runs'
  // tools at port 0, then swept as unfinished). Once ion listens: watch, sweep, routines, suggestions, answers.
  it("starts its schedules only once it listens, after the sweep", async () => {
    const order: string[] = [];
    const listen = Server.prototype.listen;
    const spies = [
      vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...a: unknown[]) {
        const done = a.at(-1) as () => void;
        return listen.apply(this, [...a.slice(0, -1), () => (order.push("listen"), done())] as never);
      }),
      ...(
        [
          [Ions.prototype, "watch"],
          [RunManager.prototype, "closeUnfinishedRuns"],
          [Routines.prototype, "start"],
          [Suggestions.prototype, "start"],
          [Decisions.prototype, "resume"],
        ] as const
      ).map(([o, m]) => {
        const f = o[m] as (...a: unknown[]) => unknown;
        return vi.spyOn(o, m as never).mockImplementation(function (this: unknown, ...a: unknown[]) {
          order.push(m === "start" ? o.constructor.name : m);
          return f.apply(this, a);
        } as never);
      }),
    ];
    const h = mkdtempSync(join(tmpdir(), "ion-order-"));
    const s2 = await startServer({ dataDir: join(h, "data"), configFile: join(h, "config.toml"), port: 0 });
    for (const s of spies) s.mockRestore();
    await s2.close();
    expect(order).toEqual(["listen", "watch", "closeUnfinishedRuns", "Routines", "Suggestions", "resume"]);
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

  // Plan 21 audit, 2026-11-23: a folder that isn't a git repo gets ion's git setup now (start.test.ts); one that isn't
  // there is still refused, plainly.
  it("rejects a folder that isn't there", async () => {
    await expect(client.call("projects.add", { path: "/nope" })).rejects.toThrow("No folder at /nope");
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

  // Plan 14: an ion's turn is a session of its own agent (here the fake one) with ion's tools over MCP: ion chief
  // starts threads with start_thread, and each thread's end comes back through a turn of its project's ion.
  it("ion chief routes with the fake agent through start_thread", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    await client.call("projects.add", { path: repo("app") });
    const seen: IonEvent[] = [];
    await client.subscribe({}, (e) => seen.push(e));
    // ion thinks with its own agent ([ion] quick), and judges with [access] judge: both fake here.
    const cf = join(home, "config.toml");
    const { config } = loadUserConfig(cf);
    // Its project's ion runs on the fake agent too: with none set, ion would pick a real one that's ready.
    saveUserConfig(cf, {
      ...config,
      ion: { ...config.ion, quick: "fake" },
      access: { ...config.access, judge: "fake" },
      projects: config.projects.map((p) => ({ ...p, harness: "fake" })),
    });
    const ionSaid = (ionId: string) =>
      seen
        .filter((e) => e.chatId === `ion:${ionId}` && e.type === "ion.said")
        .map((e) => e.data as { text: string; card?: { kind: string; threads: { chatId: string }[] } });
    await client.call("ion.message", { ionId: "chief", text: "please check app" });
    // Its own line, found by its card (full check, 2026-11-24: the thread's short report, said as-is, can already
    // follow it): ion chief's "Asked 1 project." comes first, the thread's report after.
    const chief = ionSaid("chief").find((m) => m.card?.kind === "threads")!;
    expect(chief).toMatchObject({ text: "Asked 1 project.", card: { kind: "threads" } });
    // Its turn used ion's tools: its work is on its chat.
    const tools = seen.filter((e) => e.chatId === "ion:chief" && e.type === "tool.started");
    expect(tools.map((e) => (e.data as { name: string }).name)).toEqual([
      "mcp__ion__projects",
      "mcp__ion__start_thread",
    ]);
    const thread = (await client.call("chats.list", {})).find((c) => c.by === "ion");
    expect(thread).toMatchObject({
      projectId: "app",
      title: "please check app",
      chatId: chief.card!.threads[0]!.chatId,
    });
    expect(ionSaid("app")[0]).toEqual({ text: "From ion: please check app" });
    // The thread ends: app's ion says what came of it, and ion chief passes it on. PR #36 final review, 2026-11-24:
    // the thread changed nothing and said little, so that's its own reply, with no report turn.
    await until(() => ionSaid("app").length > 2, 15_000);
    expect(ionSaid("app").at(-1)).toEqual({ text: "Hi from the fake agent." });
    await until(() => ionSaid("chief").at(-1)?.text === "Hi from the fake agent.", 15_000);
    const order = ionSaid("chief").map((m) => m.text);
    expect(order.indexOf("Asked 1 project.")).toBeLessThan(order.indexOf("Hi from the fake agent."));
  }, 20_000);

  // The user, 2026-11-19 (Settings): ion's quick model, and a project ion's setup.
  // Task review, 2026-11-20: one call (settings.set) saves every setting, the model and effort included.
  it("reads and sets ion's quick model, refusing an unknown agent", async () => {
    // Plan 21 audit, 2026-11-23: none set at first (it follows your agent order), the judge too.
    expect(await client.call("settings.get", {})).toMatchObject({ quick: "", effort: null, judge: "" });
    await client.call("settings.set", { patch: { quick: "grok-build" } });
    expect(await client.call("settings.get", {})).toMatchObject({ quick: "grok-build", effort: null });
    // Plan 21 audit, 2026-11-23: Settings shows and sets the judge's agent too, with the same picker.
    await client.call("settings.set", { patch: { judge: "opencode" } });
    expect(await client.call("settings.get", {})).toMatchObject({ quick: "grok-build", judge: "opencode" });
    // PR #36 review, 2026-11-23: the daemon says whom each follows now (yours, else your order's first) and whether
    // ion's judge evals checked the judge's model; null (or "") goes back to your order.
    expect(await client.call("settings.get", {})).toMatchObject({
      quickNow: "grok-build",
      judgeChecked: false,
    });
    const grok = `grok-build:${getHarness("grok-build")!.adapter.judge!.model}`;
    await client.call("settings.set", { patch: { judge: grok } });
    expect(await client.call("settings.get", {})).toMatchObject({ judge: grok, judgeChecked: true });
    await expect(client.call("settings.set", { patch: { judge: "nope" } })).rejects.toThrow(
      "Unknown agent: nope",
    );
    await expect(client.call("settings.set", { patch: { quick: "nope:x" } })).rejects.toThrow(
      "Unknown agent: nope",
    );
    // The user, 2026-11-19: you pick how hard ion thinks; null is the agent's own default again.
    await client.call("settings.set", { patch: { effort: "low" } });
    expect(await client.call("settings.get", {})).toMatchObject({ quick: "grok-build", effort: "low" });
    await expect(client.call("settings.set", { patch: { effort: "huge" as "low" } })).rejects.toThrow(
      "Pick low, medium, high or max",
    );
    await client.call("settings.set", { patch: { effort: null } });
    expect(await client.call("settings.get", {})).toMatchObject({ quick: "grok-build", effort: null });
    await client.call("settings.set", { patch: { judge: null, quick: null } });
    expect(await client.call("settings.get", {})).toMatchObject({ quick: "", judge: "" });
  }, 30_000);

  // PR #36 re-review, the user, 2026-11-23: ion checks the judge on your own agents. Settings lists each agent's pinned
  // judge model and whether it's checked (Grok's ships checked); a check runs ion's judge cases on it and is kept, and
  // the judge then goes on it along your order.
  it("checks an agent as judge on request, keeps it, and lists each agent's judge", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    try {
      const first = await client.call("settings.get", {});
      expect(first.judges["grok-build"]).toMatchObject({ checked: true, shipped: true, last: null });
      const lax = await client.call("judge.check", { harness: "fake" });
      expect(lax).toMatchObject({ agent: "fake", pass: false });
      process.env.ION_FAKE_JUDGE = "deny";
      expect(await client.call("judge.check", { harness: "fake" })).toMatchObject({
        pass: true,
        dangerous: [],
      });
      await client.call("settings.set", { patch: { agentOrder: ["fake"] } });
      const after = await client.call("settings.get", {});
      expect(after.judges.fake).toMatchObject({ checked: true, shipped: false, last: { pass: true } });
      expect(after).toMatchObject({ judge: "", judgeChecked: true });
      await expect(client.call("judge.check", { harness: "nope" })).rejects.toThrow("Unknown agent: nope");
    } finally {
      delete process.env.ION_FAKE_JUDGE;
    }
  }, 60_000);

  // Plan 21 Task 5, 2026-11-28: "Check the agents each night" is off until you turn it on; Check now runs the same
  // small check on the agents that are in (one that isn't free only when you pick it), through ion's own server.
  it("checks the agents each night only once you turn it on, and now on request", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    const first = await client.call("agents.checks", {});
    expect(first).toMatchObject({ nightly: false, running: false, last: [] });
    // Only the fake agent is checked here: the others are avoided (no real agent, nothing slow to ask).
    const others = ["claude-code", "codex", "grok-build", "opencode"];
    await client.call("settings.set", {
      patch: { avoid: Object.fromEntries(others.map((id) => [id, true])) },
    });
    const on = await client.call("agents.checks", { nightly: true, pick: { fake: true } });
    expect(on.nightly).toBe(true);
    expect(on.agents.find((a) => a.agent === "fake")).toMatchObject({ picked: true, included: true });
    const done = await client.call("agents.check", {});
    const fake = done.last.find((r) => r.agent === "fake");
    expect(fake?.checks.slice(0, 2)).toEqual([
      { name: "Signed in", ok: true },
      { name: "Starts", ok: true },
    ]);
    await expect(client.call("agents.checks", { pick: { nope: true } })).rejects.toThrow(
      "Unknown agent: nope",
    );
  }, 120_000);

  // The user, 2026-11-18: the preview shows a chat's files and what's running in its worktree, with PIDs.
  it("previews a chat's file and lists its background tasks", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    await client.call("projects.add", { path: repo("app") });
    const seen: IonEvent[] = [];
    await client.subscribe({}, (e) => seen.push(e));
    const { chatId, runId } = await client.call("ask", { text: "edit", harness: "fake", projectId: "app" });
    await until(() => seen.some((e) => e.runId === runId && e.type === "run.finished"), 5000);
    expect(await client.call("chat.file", { chatId, path: "notes.md" })).toMatchObject({ kind: "text" });
    await expect(client.call("chat.file", { chatId, path: "../../x" })).rejects.toThrow(
      "That file isn't in this chat",
    );
    expect(await client.call("chat.tasks", { chatId })).toEqual([]);
    // The user, 2026-11-19: the workspace preview should also list artifacts.
    const made = await client.call("chat.artifacts", { chatId });
    expect(made.map((f) => f.path)).toContain("notes.md");
    expect(await client.call("chat.artifacts", { chatId: "nope" })).toEqual([]);
    await expect(client.call("task.stop", { chatId, pid: 1 })).rejects.toThrow(
      "That isn't running in this chat",
    );
    await expect(client.call("chat.tasks", { chatId: "nope" })).rejects.toThrow("That chat has no workspace");
  });

  it("gives an ion's stats: its threads' runs over 30 days", async () => {
    await client.call("projects.add", { path: repo("app") });
    expect(await client.call("ion.stats", { ionId: "app" })).toMatchObject({
      runs: 0,
      succeeded: 0,
      costUsd: 0,
    });
    expect((await client.call("ion.stats", { ionId: "chief" })).perDay).toHaveLength(30);
    await expect(client.call("ion.stats", { ionId: "nope" })).rejects.toThrow("Unknown ion: nope");
  });

  // Task review, 2026-11-21: access is no longer a project setting (only the composer's access icon switches it).
  it("sets a project ion's agent, colour, model and effort, and checks them; access isn't one", async () => {
    await client.call("projects.add", { path: repo("app") });
    await client.call("project.update", {
      projectId: "app",
      harness: "grok-build",
      color: "#ED712E",
      model: "grok-code",
      effort: "high",
      access: "full",
      shareWithIon: false,
    } as never);
    expect((await client.call("projects.list", {}))[0]).toMatchObject({
      harness: "grok-build",
      color: "#ED712E",
      model: "grok-code",
      effort: "high",
      shareWithIon: false,
    });
    expect((await client.call("projects.list", {}))[0]).not.toHaveProperty("access");
    expect((await client.call("ions.list", {}))[1]).toMatchObject({
      harness: "grok-build",
      color: "#ED712E",
    });
    await client.call("project.update", { projectId: "app", model: null });
    expect((await client.call("projects.list", {}))[0]).not.toHaveProperty("model");
    await expect(client.call("project.update", { projectId: "app", harness: "nope" })).rejects.toThrow(
      "Unknown agent: nope",
    );
    await expect(client.call("project.update", { projectId: "app", color: "red" })).rejects.toThrow(
      "Pick a colour",
    );
    await expect(client.call("project.update", { projectId: "app", effort: "huge" })).rejects.toThrow(
      "Pick low, medium, high or max",
    );
  });

  // Review, 2026-11-19: project.update wrote any field it was sent: `{projectId, path}` moved the project.
  it("changes only the fields Settings may change on a project", async () => {
    const path = repo("app");
    await client.call("projects.add", { path });
    await client.call("project.update", {
      projectId: "app",
      color: "#ED712E",
      path: "/elsewhere",
      id: "x",
    } as never);
    expect((await client.call("projects.list", {}))[0]).toMatchObject({ id: "app", path, color: "#ED712E" });
  });

  // Plan 14 (2026-11-19): you set a project's profile in Settings; its ion's suggestion only counts once you accept
  // it, so the app may clear a suggestion but never write one.
  it("sets a project's profile, at most 300 characters, and only clears a suggestion", async () => {
    await client.call("projects.add", { path: repo("app") });
    const file = join(home, "config.toml");
    const { config } = loadUserConfig(file);
    saveUserConfig(file, {
      ...config,
      projects: config.projects.map((p) => ({ ...p, profileSuggestion: "A shop." })),
    });
    await client.call("project.update", { projectId: "app", profile: "The storefront." });
    expect((await client.call("projects.list", {}))[0]).toMatchObject({
      profile: "The storefront.",
      profileSuggestion: "A shop.",
    });
    await expect(
      client.call("project.update", { projectId: "app", profile: "x".repeat(301) }),
    ).rejects.toThrow("Keep it under 300 characters");
    await expect(
      client.call("project.update", { projectId: "app", profileSuggestion: "Mine." } as never),
    ).rejects.toThrow("Only its ion suggests a profile");
    expect((await client.call("projects.list", {}))[0]?.profileSuggestion).toBe("A shop.");
    // Task review, 2026-11-19: a profile that isn't text was written as is.
    await expect(client.call("project.update", { projectId: "app", profile: 42 } as never)).rejects.toThrow(
      "Write the profile as text",
    );
    await client.call("project.update", { projectId: "app", profile: null, profileSuggestion: null });
    const p = (await client.call("projects.list", {}))[0];
    expect(p).not.toHaveProperty("profile");
    expect(p).not.toHaveProperty("profileSuggestion");
  });

  // The user, 2026-11-19: rename a project (the name ion shows; its id stays).
  it("renames a project, and its ion takes the name", async () => {
    await client.call("projects.add", { path: repo("app") });
    await client.call("project.rename", { projectId: "app", name: "Storefront" });
    expect((await client.call("projects.list", {}))[0]).toMatchObject({ id: "app", name: "Storefront" });
    expect((await client.call("ions.list", {}))[1]).toMatchObject({ ionId: "app", name: "Storefront" });
    await expect(client.call("project.rename", { projectId: "app", name: " " })).rejects.toThrow(
      "Give the project a name",
    );
  });

  // The user, 2026-11-19: remove a project. Its chats are archived (worktrees and questions closed); its folder stays.
  it("removes a project: archives its chats, keeps its folder, refuses while one runs", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    const path = repo("app");
    await client.call("projects.add", { path });
    const seen: IonEvent[] = [];
    await client.subscribe({}, (e) => seen.push(e));
    const slow = await client.call("ask", { text: "slow", harness: "fake", projectId: "app" });
    await until(() => seen.some((e) => e.runId === slow.runId && e.type === "run.started"), 5000);
    await expect(client.call("project.remove", { projectId: "app" })).rejects.toThrow(
      "Stop its running chats first",
    );
    await client.call("run.interrupt", { runId: slow.runId });
    await until(() => seen.some((e) => e.runId === slow.runId && e.type === "run.finished"), 5000);
    // A decision you made for the project (here: whether to merge → wait, for the project).
    const asked = await client.call("ask", { text: "asks", harness: "fake", projectId: "app" });
    await until(() => seen.some((e) => e.runId === asked.runId && e.type === "run.finished"), 5000);
    const [need] = await client.call("needs.list", { chatId: asked.chatId });
    await client.call("need.answer", { needId: need!.needId, choice: 2, scope: "project" });
    await until(() => seen.some((e) => e.type === "decision.outcome"), 5000);
    expect(await client.call("decisions.list", { projectId: "app" })).toHaveLength(1);
    await client.call("project.remove", { projectId: "app" });
    expect(await client.call("projects.list", {})).toEqual([]);
    // Security review: what you decided for it goes with it, so a later project of the same name starts clean.
    expect(await client.call("decisions.list", { projectId: "app" })).toEqual([]);
    expect((await client.call("chats.list", {})).filter((c) => c.projectId === "app" && !c.archived)).toEqual(
      [],
    );
    expect(statSync(path).isDirectory()).toBe(true);
    await expect(client.call("project.remove", { projectId: "default" })).rejects.toThrow(
      "default can't be removed",
    );
  });

  // Review, 2026-11-19: removing a project kept it in your config while its chats were archived, so a routine or an
  // ion message in that time could start a chat in it.
  it("starts nothing in a project while it's being removed", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    await client.call("projects.add", { path: repo("app") });
    const seen: IonEvent[] = [];
    await client.subscribe({}, (e) => seen.push(e));
    const first = await client.call("ask", { text: "edit", harness: "fake", projectId: "app" });
    await until(() => seen.some((e) => e.runId === first.runId && e.type === "run.finished"), 5000);
    const removing = client.call("project.remove", { projectId: "app" });
    const late = client.call("ask", { text: "edit", harness: "fake", projectId: "app" }).then(
      () => "started",
      (e: Error) => e.message,
    );
    await removing;
    expect(await late).toBe("Unknown project: app");
    expect((await client.call("chats.list", {})).filter((c) => !c.archived)).toEqual([]);
  });

  // The lab: a project's ion can be starred (Starred first in Ions and the project menu).
  it("stars and unstars a project, and its ion says so", async () => {
    await client.call("projects.add", { path: repo("app") });
    await client.call("project.star", { projectId: "app", starred: true });
    expect((await client.call("projects.list", {}))[0]).toMatchObject({ id: "app", starred: true });
    expect((await client.call("ions.list", {}))[1]).toMatchObject({ ionId: "app", starred: true });
    await client.call("project.star", { projectId: "app", starred: false });
    expect((await client.call("ions.list", {}))[1]).toMatchObject({ starred: false });
    await expect(client.call("project.star", { projectId: "nope", starred: true })).rejects.toThrow(
      "Unknown project: nope",
    );
  });

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

  // Review of #34, 2026-11-23: chat.remember took anything for `on` ("no" turned memory off as if false).
  it("doesn't remember a chat, and takes only true or false", async () => {
    const { chatId } = await client.call("chat.create", { title: "Private" });
    await client.call("chat.remember", { chatId, on: false });
    expect((await client.call("chats.list", {})).find((c) => c.chatId === chatId)?.notRemembered).toBe(true);
    await expect(client.call("chat.remember", { chatId, on: "yes" as unknown as boolean })).rejects.toThrow(
      "Pick on or off",
    );
    await client.call("chat.remember", { chatId, on: true });
    expect((await client.call("chats.list", {})).find((c) => c.chatId === chatId)).not.toHaveProperty(
      "notRemembered",
    );
  });

  // Final review, 2026-11-19: Stop on a chat's run sent its next queued message right after, so the work went on.
  // What's queued waits ("Stopped") until you send a message (or deal with a queued one).
  it("Stop holds the chat's queue until you send a message", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    await client.call("projects.add", { path: repo("app") });
    const seen: IonEvent[] = [];
    await client.subscribe({}, (e) => seen.push(e));
    const ends = () => seen.filter((e) => e.type === "run.finished").length;
    const slow = await client.call("ask", { text: "slow", harness: "fake", projectId: "app" });
    await until(() => seen.some((e) => e.runId === slow.runId && e.type === "run.started"), 5000);
    const to = { chatId: slow.chatId };
    await client.call("queue.add", { to, text: "hello queued", brain: { harness: "fake" } });
    await client.call("run.interrupt", { runId: slow.runId });
    await until(() => ends() === 1, 5000);
    await new Promise((r) => setTimeout(r, 200));
    expect((await client.call("queue.list", { to })).map((q) => q.why)).toEqual(["Stopped"]);
    await client.call("ask", { chatId: slow.chatId, text: "hello direct", harness: "fake" });
    await until(() => ends() === 3, 5000);
    const said = seen.filter((e) => e.type === "message.sent").map((e) => (e.data as { text: string }).text);
    expect(said).toEqual(["slow", "hello direct", "hello queued"]);
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
