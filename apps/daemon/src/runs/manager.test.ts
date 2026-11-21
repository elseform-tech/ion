import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addProject, DEFAULT_CONFIG, loadUserConfig, saveUserConfig } from "@ion/config";
import type { StartOpts } from "@ion/adapter-kit";
import { EV, type IonEvent } from "@ion/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAccess } from "../access/index.js";
import { UserError } from "../api/errors.js";
import { createGrants } from "../mcp/index.js";
import { NeedsService } from "../needs/index.js";
import { memorySecrets } from "../secrets/index.js";
import { createTools } from "../tools/index.js";
import { serversFor } from "../tools/run-servers.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { allViews } from "../views/index.js";
import { RunManager } from "./manager.js";

/** How often a fake harness was asked whether it's installed. */
const detects = vi.hoisted(() => ({ n: 0 }));
/** What each fake agent was started with (its MCP servers: what the agent's config holds). */
const started = vi.hoisted(() => [] as Partial<StartOpts>[]);
vi.mock("@ion/adapter-fake", async (real) => {
  const m = await real<typeof import("@ion/adapter-fake")>();
  return {
    ...m,
    createFakeAdapter: (...a: Parameters<typeof m.createFakeAdapter>) => {
      const adapter = m.createFakeAdapter(...a);
      const detect = adapter.detect.bind(adapter);
      adapter.detect = () => {
        detects.n++;
        return detect();
      };
      const start = adapter.start.bind(adapter);
      adapter.start = (opts) => {
        const { mcpServers, env, pluginDir, ownTools, ownServers } = opts;
        started.push(structuredClone({ mcpServers, env, pluginDir, ownTools, ownServers }));
        return start(opts);
      };
      return adapter;
    },
  };
});

process.env.ION_ALLOW_FAKE = "1";

let db: Db;
let store: EventStore;
let needs: NeedsService;
let runs: RunManager;
let repo: string;
let configFile: string;
let judge: ReturnType<typeof vi.fn>;
let access: ReturnType<typeof createAccess>;
let dataDir: string;

/** A manager with these besides the usual (config, data folder, Auto). */
const managerWith = (more: object) =>
  new RunManager(store, { configFile, dataDir, random: () => 0, access, ...more }, needs, db);

/** A fresh manager that reads max_runs from the config file. */
const limitTo = (n: number) => {
  const c = addProject(DEFAULT_CONFIG, repo);
  saveUserConfig(configFile, { ...c, resources: { max_runs: n } });
  runs = new RunManager(store, { configFile, dataDir, random: () => 0, access }, needs, db);
};

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ion-runs-"));
  repo = join(home, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  configFile = join(home, "config.toml");
  dataDir = join(home, "data");
  saveUserConfig(configFile, addProject(DEFAULT_CONFIG, repo));
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  needs = new NeedsService(store, db);
  judge = vi.fn(async ({ req }: { req: { input: unknown } }) =>
    JSON.stringify(req.input).includes("/etc/")
      ? { allow: false, reason: "Outside the project" }
      : { allow: true, reason: "Fine for the task" },
  );
  access = createAccess({ judge, home: "/nonexistent-home", ionDirs: [dataDir] });
  runs = new RunManager(store, { configFile, dataDir, random: () => 0, access }, needs, db);
});

async function until<T>(f: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const finished = (runId: string): Promise<IonEvent[]> =>
  until(() => {
    const events = store.read({ runId });
    return events.some((e) => e.type === "run.finished") ? events : undefined;
  });
const openNeed = () => until(() => needs.open()[0]);

const ask = (text: string, extra: object = {}) =>
  runs.ask({ text, projectId: "repo", harness: "fake", ...extra });

describe("RunManager", () => {
  // The user, 2026-11-21: each agent brings its own servers, skills and plugins into a chat (its "Use its own tools",
  // on); off, ion's tools only. A key of its own never reaches the chat's events.
  it("Use its own tools off brings back ion's tools only (what the agent is told)", async () => {
    const key = "own-secret-key-0123456789";
    const ownServers = [
      { name: "gh", transport: "stdio" as const, command: "gh", args: [], env: { T: key } },
    ];
    const own = { forRun: async () => ({ ownTools: true, ownServers, secrets: [key] }) };
    runs = managerWith({ own });
    const said = JSON.stringify(
      (await finished((await ask(`echo ${key}`)).runId)).filter((e) => e.origin === "adapter"),
    );
    expect(started.at(-1)).toMatchObject({ ownTools: true, ownServers: [{ name: "gh" }] });
    expect([said.includes("•••"), said.includes(key)]).toEqual([true, false]);
  });

  // The user, 2026-11-20 (skills, T3 Code's way): the plugin folder is made for each run in ion's data folder and
  // removed when the run ends; a run's skills that can't be made don't fail it.
  it("gives a run its skills plugin and removes it at run end", async () => {
    const calls: string[] = [];
    const skills = {
      forRun: async (r: { runId: string; harness: string; projectId: string }) => {
        calls.push(`make ${r.harness} ${r.projectId}`);
        return join(dataDir, "skills", r.runId);
      },
      remove: async (runId: string) => void calls.push(`remove ${runId}`),
    };
    runs = new RunManager(store, { configFile, dataDir, random: () => 0, access, skills }, needs, db);
    const { runId } = await ask("hello");
    await finished(runId);
    await until(() => calls.length === 2 || undefined);
    expect(started.at(-1)?.pluginDir).toBe(join(dataDir, "skills", runId));
    expect(calls).toEqual(["make fake repo", `remove ${runId}`]);
    const failing = { forRun: () => Promise.reject(new Error("disk full")), remove: async () => {} };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runs = managerWith({ skills: failing });
    const two = await ask("hello");
    expect((await finished(two.runId)).at(-1)?.data).toEqual({ status: "done" });
    // No own tools for the run ("Use its own tools" off, or none to read): ion's tools only.
    expect(started.at(-1)).toMatchObject({ pluginDir: undefined, ownTools: undefined });
  });

  it("creates a chat with its own worktree and stores the run's events in order", async () => {
    const { chatId, runId } = await ask("hello");
    const types = (await finished(runId)).map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(["message.sent", "run.queued", "run.started"]);
    expect(types.at(-1)).toBe("run.finished");
    expect(store.read({ chatId })[0]).toMatchObject({
      type: "chat.created",
      data: { worktree: expect.any(String) },
    });
    expect(existsSync(join(chatsView.worktree(db, chatId)!, "README.md"))).toBe(true);
  });

  it("stores what you asked, and the harness session of each run", async () => {
    const { chatId, runId } = await ask("hello there");
    const events = await finished(runId);
    expect(events[0]).toMatchObject({ type: "message.sent", data: { text: "hello there" } });
    expect(chatsView.session(db, chatId)).toEqual({
      harness: "fake",
      sessionId: expect.stringMatching(/^fake-/),
    });
  });

  it("allows an edit inside the chat's worktree without asking; the file lands there, not in the checkout", async () => {
    const { chatId, runId } = await ask("approve");
    const events = await finished(runId);
    expect(events.find((e) => e.type === "approval.resolved")).toMatchObject({
      data: { decision: "allow", by: "policy" },
    });
    expect(events.some((e) => e.type === "need.raised")).toBe(false);
    expect(existsSync(join(chatsView.worktree(db, chatId)!, "notes.md"))).toBe(true);
    expect(existsSync(join(repo, "notes.md"))).toBe(false);
  });

  const approval = (events: IonEvent[]) => events.find((e) => e.type === "approval.resolved")?.data;

  it("Auto: ion decides a command and the run never pauses", async () => {
    const { runId } = await ask("shell");
    const events = await finished(runId);
    expect(approval(events)).toEqual({
      requestId: "q1",
      decision: "allow",
      by: "ion",
      reason: "Fine for the task",
    });
    expect(events.find((e) => e.type === "tool.finished")).toMatchObject({ data: { ok: true } });
    expect(events.some((e) => e.type === "need.raised")).toBe(false);
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ projectId: "repo", text: "shell" }));
  });

  it("Auto: what ion denies goes back to the agent with the reason, and the run carries on", async () => {
    const events = await finished((await ask("outside")).runId);
    expect(approval(events)).toMatchObject({ decision: "deny", by: "ion", reason: "Outside the project" });
    expect(events.at(-1)?.data).toEqual({ status: "done" });
    expect(events.some((e) => e.type === "need.raised")).toBe(false);
  });

  // Review Focus 4: Full access never asks the judge.
  it("Full access: everything runs, without asking ion", async () => {
    const events = await finished((await ask("outside", { access: "full" })).runId);
    expect(approval(events)).toMatchObject({ decision: "allow", by: "full" });
    expect(judge).not.toHaveBeenCalled();
  });

  // Task review, 2026-11-21: a project's access (set in Settings or with `ion projects access`) still ran its chats
  // in Full access; the user ruled (2026-11-20) that only the composer's access icon switches Auto-approval.
  it("a project's access is ignored: new chats start on Auto", async () => {
    saveUserConfig(configFile, addProject(DEFAULT_CONFIG, repo));
    writeFileSync(
      configFile,
      readFileSync(configFile, "utf8").replace(/(path = .*\n)/, '$1access = "full"\n'),
    );
    expect(readFileSync(configFile, "utf8")).toContain('access = "full"');
    runs = new RunManager(store, { configFile, dataDir, random: () => 0, access }, needs, db);
    expect(approval(await finished((await ask("shell")).runId))).toMatchObject({ by: "ion" });
    expect(approval(await finished((await ask("shell", { access: "full" })).runId))).toMatchObject({
      by: "full",
    });
  });

  // Final review I2: a thread ion started runs in Auto every time, whatever the project's access.
  it("runs every run of an ion thread in Auto, even in a Full access project", async () => {
    saveUserConfig(configFile, addProject(DEFAULT_CONFIG, repo));
    runs = new RunManager(store, { configFile, dataDir, random: () => 0, access }, needs, db);
    const first = await runs.ask({ text: "shell", projectId: "repo", harness: "fake" }, { by: "ion" });
    expect(approval(await finished(first.runId))).toMatchObject({ by: "ion" });
    const next = await runs.ask({ text: "shell", chatId: first.chatId, harness: "fake", access: "full" });
    expect(approval(await finished(next.runId))).toMatchObject({ by: "ion" });
  });

  // Final review I1: archiving a chat closes its questions, so nothing waits behind them unseen.
  it("closes a chat's open questions when it's archived", async () => {
    const { chatId, runId } = await ask("hello");
    await finished(runId);
    const needId = needs.raiseAsk({
      chatId,
      runId,
      question: "Q?",
      choices: [
        { label: "A", consequence: "a" },
        { label: "B", consequence: "b" },
      ],
    });
    await runs.archive(chatId);
    expect(needs.open(chatId, true)).toEqual([]);
    expect(store.read({ chatId }).find((e) => e.type === "need.resolved")?.data).toMatchObject({
      needId,
      decision: "superseded",
    });
  });

  it("archives a chat: removes its worktree, keeps the branch, refuses while running", async () => {
    const { chatId, runId } = await ask("slow");
    await expect(runs.archive(chatId)).rejects.toThrow(new UserError("Stop the chat's run first"));
    await runs.interrupt(runId);
    await finished(runId);
    const wt = chatsView.worktree(db, chatId)!;
    await runs.archive(chatId);
    expect(existsSync(wt)).toBe(false);
    expect(chatsView.list(db)[0]).toMatchObject({ chatId, archived: true });
    await expect(ask("hello", { chatId })).rejects.toThrow(new UserError("That chat is archived"));
  });

  it("queues runs beyond the limit and starts them as slots free up", async () => {
    limitTo(1);
    const a = await ask("slow");
    const b = await ask("hello");
    expect(store.read({ runId: b.runId }).map((e) => e.type)).toEqual(["message.sent", "run.queued"]);
    await runs.interrupt(a.runId);
    const types = (await finished(b.runId)).map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(["message.sent", "run.queued", "run.started"]);
  });

  // Task review, 2026-11-20: the limit was read from config.toml on every pump; it's read when the manager is made
  // and when Settings changes it (limitChanged).
  it("reads the limit once, and again when it changes", async () => {
    limitTo(1);
    saveUserConfig(configFile, { ...addProject(DEFAULT_CONFIG, repo), resources: { max_runs: 3 } });
    const a = await ask("slow");
    const b = await ask("slow");
    await new Promise((r) => setTimeout(r, 100));
    expect(store.read({ runId: b.runId }).map((e) => e.type)).toEqual(["message.sent", "run.queued"]);
    runs.limitChanged();
    await until(() => store.read({ runId: b.runId }).find((e) => e.type === "run.started"));
    await runs.interrupt(a.runId);
    await runs.interrupt(b.runId);
    await finished(a.runId);
    await finished(b.runId);
  });

  // Task review, 2026-11-20: lowering max_runs only holds back new starts; chats already running carry on.
  it("lowering the limit never stops running chats", async () => {
    limitTo(2);
    const a = await ask("slow");
    const b = await ask("slow");
    const c = await ask("slow");
    await until(() => store.read({ runId: b.runId }).find((e) => e.type === "run.started"));
    saveUserConfig(configFile, { ...addProject(DEFAULT_CONFIG, repo), resources: { max_runs: 1 } });
    runs.limitChanged();
    await new Promise((r) => setTimeout(r, 50));
    for (const r of [a, b])
      expect(store.read({ runId: r.runId }).some((e) => e.type === "run.finished")).toBe(false);
    expect(store.read({ runId: c.runId }).some((e) => e.type === "run.started")).toBe(false);
    for (const r of [a, b, c]) await runs.interrupt(r.runId);
    for (const r of [a, b, c]) await finished(r.runId);
  });

  it("interrupting a queued run finishes it without starting the harness", async () => {
    limitTo(1);
    const a = await ask("slow");
    const b = await ask("hello");
    await runs.interrupt(b.runId);
    expect(store.read({ runId: b.runId }).map((e) => e.type)).toEqual([
      "message.sent",
      "run.queued",
      "run.finished",
    ]);
    expect(store.read({ runId: b.runId }).at(-1)?.data).toEqual({ status: "interrupted" });
    await runs.interrupt(a.runId);
    await finished(a.runId);
  });

  it("retries a transient failure: twice rate-limited, then done", async () => {
    const { runId } = await ask("flaky");
    const events = await finished(runId);
    expect(events.filter((e) => e.type === "run.retrying").map((e) => e.data)).toEqual([
      { attempt: 1, delayS: 0, reason: "Rate limited", effort: null },
      { attempt: 2, delayS: 0, reason: "Rate limited", effort: null },
    ]);
    expect(events.filter((e) => e.type === "run.started")).toHaveLength(3);
    expect(events.filter((e) => e.type === "run.finished")).toHaveLength(1);
    expect(events.at(-1)?.data).toEqual({ status: "done" });
  });

  it("stops after 4 tries of a transient failure, with the last error shown", async () => {
    const { runId } = await ask("overloaded");
    const events = await finished(runId);
    expect(events.filter((e) => e.type === "run.started")).toHaveLength(4);
    expect(events.filter((e) => e.type === "run.retrying")).toHaveLength(3);
    expect(events.at(-2)).toMatchObject({ type: "error", data: { message: "Rate limited" } });
    expect(events.at(-1)?.data).toEqual({ status: "failed" });
  });

  it("retries a real failure once at the next effort, and not above max", async () => {
    const high = await finished((await ask("fail", { effort: "high" })).runId);
    expect(
      high.filter((e) => e.type === "run.started").map((e) => (e.data as { effort: string }).effort),
    ).toEqual(["high", "max"]);
    expect(high.at(-1)?.data).toEqual({ status: "failed" });
    const max = await finished((await ask("fail", { effort: "max" })).runId);
    expect(max.filter((e) => e.type === "run.started")).toHaveLength(1);
  });

  // Final review I3: an interrupt during start used to still send the prompt.
  it("an interrupt while the harness starts ends the run without sending the prompt", async () => {
    process.env.ION_FAKE_START_MS = "150";
    try {
      const { chatId, runId } = await ask("approve");
      await new Promise((r) => setTimeout(r, 40));
      await runs.interrupt(runId);
      const events = await finished(runId);
      expect(events.at(-1)?.data).toEqual({ status: "interrupted" });
      expect(events.some((e) => e.type === "run.started")).toBe(false);
      await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(join(chatsView.worktree(db, chatId)!, "notes.md"))).toBe(false);
    } finally {
      delete process.env.ION_FAKE_START_MS;
    }
  });

  // Final review I5: nothing is stored after a run's end, even when a start fails during shutdown.
  it("stores nothing after run.finished when ion stops during a failing start", async () => {
    process.env.ION_FAKE_START_MS = "100";
    process.env.ION_FAKE_START_FAIL = "1";
    try {
      const { runId } = await ask("hello");
      await new Promise((r) => setTimeout(r, 30));
      await runs.shutdown();
      await new Promise((r) => setTimeout(r, 150));
      expect(store.read({ runId }).at(-1)).toMatchObject({
        type: "run.finished",
        data: { status: "failed" },
      });
    } finally {
      delete process.env.ION_FAKE_START_MS;
      delete process.env.ION_FAKE_START_FAIL;
    }
  });

  // Final review I2 / Review Focus 1: answering a need after a restart says the run stopped.
  it("after a restart, answering the old need says the run stopped", async () => {
    const { chatId, runId } = await ask("slow");
    // An old permission need, as an older ion left it.
    store.append({
      chatId,
      runId,
      origin: "daemon",
      type: EV.needRaised,
      data: { needId: "n9", requestId: "q9", kind: "command", summary: "x", detail: null, dedupeKey: "k" },
    });
    const need = await openNeed();
    const restarted = new RunManager(store, { configFile, dataDir, random: () => 0 }, needs, db);
    restarted.closeUnfinishedRuns([{ runId, chatId, status: "running" }]);
    expect(() => needs.openNeed(need.needId)).toThrow(new UserError("That run stopped"));
    await runs.shutdown();
  });

  // Final review minor 3: a chat stays in its own project.
  it("keeps a chat in its own project whatever -p says", async () => {
    const { chatId, runId } = await ask("hello");
    await finished(runId);
    const again = await ask("hello", { chatId, projectId: "nope" });
    expect((await finished(again.runId)).at(-1)?.data).toEqual({ status: "done" });
  });

  const said = (events: IonEvent[]) =>
    events.filter((e) => e.type === "message.completed").map((e) => (e.data as { text: string }).text);
  const sessionOf = (events: IonEvent[]) =>
    events.filter((e) => e.type === "run.started").map((e) => (e.data as { sessionId: string }).sessionId);

  it("continues a chat by resuming its session, sending just your message", async () => {
    const first = await ask("echo one");
    const a = await finished(first.runId);
    const second = await ask("echo two", { chatId: first.chatId });
    const b = await finished(second.runId);
    expect(sessionOf(b)).toEqual(sessionOf(a));
    expect(said(b)).toEqual(["echo two"]);
  });

  // Review Focus 1: a session the harness can't resume.
  it("falls back to a new session with the chat's history when the session can't be resumed", async () => {
    const first = await ask("echo one");
    const a = await finished(first.runId);
    process.env.ION_FAKE_RESUME_FAIL = "1";
    try {
      const second = await ask("echo two", { chatId: first.chatId });
      const b = await finished(second.runId);
      expect(sessionOf(b)).not.toEqual(sessionOf(a));
      expect(said(b)[0]).toMatch(
        /^<ion-data id="\w+" source="this chat's earlier messages">\nyou: "echo one"\nagent: "echo one"\n<\/ion-data id="\w+">\n\necho two$/,
      );
      expect(b.some((e) => e.type === "error")).toBe(false);
      expect(b.at(-1)?.data).toEqual({ status: "done" });
    } finally {
      delete process.env.ION_FAKE_RESUME_FAIL;
    }
  });

  it("replays the history when the chat has no session to resume", async () => {
    process.env.ION_FAKE_START_FAIL = "1";
    const first = await ask("echo one");
    await finished(first.runId);
    delete process.env.ION_FAKE_START_FAIL;
    const b = await finished((await ask("echo two", { chatId: first.chatId })).runId);
    expect(said(b)[0]).toMatch(/you: "echo one"\n<\/ion-data id="\w+">\n\necho two$/);
  });

  // Final review minor 3: a session that resumes but then fails for real doesn't trap the chat.
  it("starts a new session with the history when the resumed one fails", async () => {
    const first = await ask("echo one");
    const a = await finished(first.runId);
    process.env.ION_FAKE_RESUMED_FAILS = "1";
    try {
      const b = await finished((await ask("echo two", { chatId: first.chatId, effort: "low" })).runId);
      expect(b.at(-1)?.data).toEqual({ status: "done" });
      expect(sessionOf(b).at(-1)).not.toBe(sessionOf(a)[0]);
      expect(said(b).at(-1)).toMatch(/you: "echo one"/);
    } finally {
      delete process.env.ION_FAKE_RESUMED_FAILS;
    }
  });

  // Final review minor 5: interrupted while a resume is refused, no new session starts.
  it("starts no new session when interrupted while the resume is refused", async () => {
    const first = await ask("echo one");
    await finished(first.runId);
    process.env.ION_FAKE_RESUME_FAIL = "1";
    process.env.ION_FAKE_START_MS = "120";
    try {
      const { runId } = await ask("echo two", { chatId: first.chatId });
      await new Promise((r) => setTimeout(r, 40));
      await runs.interrupt(runId);
      const b = await finished(runId);
      expect(b.at(-1)?.data).toEqual({ status: "interrupted" });
      expect(b.some((e) => e.type === "run.started")).toBe(false);
    } finally {
      delete process.env.ION_FAKE_RESUME_FAIL;
      delete process.env.ION_FAKE_START_MS;
    }
  });

  it("resumes the failed try's session when it retries", async () => {
    const events = await finished((await ask("flaky")).runId);
    const ids = sessionOf(events);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });

  it("gives each run ion's MCP server with its own key, revoked when the run ends", async () => {
    const grants = createGrants();
    const keys: string[] = [];
    const create = grants.create.bind(grants);
    grants.create = (...a: Parameters<typeof create>) => {
      const k = create(...a);
      keys.push(k);
      return k;
    };
    runs = managerWith({ mcp: { grants, url: () => "http://127.0.0.1:9/mcp" } });
    const events = await finished((await ask("mcpinfo")).runId);
    const info = JSON.parse(said(events)[0]!) as {
      name: string;
      url: string;
      headers: { Authorization: string };
    };
    // Task review, 2026-11-20: the agent saw the run's key; what it said of it is stored redacted.
    expect(info).toMatchObject({
      name: "ion",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer •••" },
    });
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(grants.check(keys[0]!)).toBeNull();
  });

  // The user, 2026-11-19: the workspace lists every process a chat's tool calls left running, wherever they run;
  // each run's agent carries the chat's marker, which those processes inherit.
  it("marks each run's agent process with its chat", async () => {
    const { chatId, runId } = await ask("envinfo");
    expect(JSON.parse(said(await finished(runId))[0]!)).toEqual({ ION_CHAT: chatId });
  });

  // The user, 2026-11-18: Claude and Grok wrote their questions as text (you got no question to answer); only
  // opencode used ion's ask tool. Every run with ion's tools is told to ask through it.
  it("tells each run with ion's tools to ask you through ion's ask tool", async () => {
    runs = new RunManager(
      store,
      {
        configFile,
        dataDir,
        random: () => 0,
        access,
        mcp: { grants: createGrants(), url: () => "http://127.0.0.1:9/mcp" },
      },
      needs,
      db,
    );
    const told = said(await finished((await ask("instructions")).runId))[0] ?? "";
    expect(told).toContain("ask tool");
    expect(told).toContain("never");
    // Memory test on Grok, 2026-11-19: ion's memory worked, but only because Grok found its tools; every run is told.
    expect(told).toContain("memory_list");
    expect(told).toContain("memory_write");
    // User, 2026-11-19: chain read-only lookups into one command to scale tools and save cost.
    expect(told).toContain("When you need several read-only lookups, chain them into one command with &&");
  });

  it("refuses a model the harness doesn't list, and runs one it does", async () => {
    await expect(ask("hello", { model: "nope" })).rejects.toThrow(
      new UserError("Unknown model for Fake: nope"),
    );
    const { runId } = await ask("hello", { model: "fake-big" });
    expect((await finished(runId)).find((e) => e.type === "run.started")?.data).toMatchObject({
      model: "fake-big",
    });
  });

  it("stores a failed run and keeps working", async () => {
    const { runId } = await ask("fail");
    expect((await finished(runId)).at(-1)?.data).toEqual({ status: "failed" });
    const again = await ask("hello");
    expect((await finished(again.runId)).at(-1)?.data).toEqual({ status: "done" });
  });

  it("refuses a second run in a chat that's still running", async () => {
    const { chatId, runId } = await ask("slow");
    await expect(ask("hello", { chatId })).rejects.toThrow("This chat is already running");
    await runs.interrupt(runId);
    expect((await finished(runId)).at(-1)?.data).toEqual({ status: "interrupted" });
  });

  it("runs only one of two concurrent asks on the same chat", async () => {
    const { chatId, runId } = await ask("hello");
    await finished(runId);
    const results = await Promise.allSettled([ask("slow", { chatId }), ask("slow", { chatId })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const ok = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ runId: string }>;
    await runs.interrupt(ok.value.runId);
    await finished(ok.value.runId);
  });

  it("refuses a signed-out harness with the sign-in hint and stores nothing", async () => {
    process.env.ION_FAKE_SIGNED_OUT = "1";
    try {
      await expect(ask("hello")).rejects.toThrow("Fake isn't signed in. Run: ion fake login");
      expect(store.read({})).toHaveLength(0);
    } finally {
      delete process.env.ION_FAKE_SIGNED_OUT;
    }
  });

  // UX tour, 2026-11-18: each message waited seconds while the agent's CLI was asked again whether it's installed
  // and signed in. A check that passed holds for a while; one that failed is asked again next time.
  // UX tour: a long first message makes a title cut at a word, marked as cut.
  it("titles a chat by its first line, cut at a word with an ellipsis when long", async () => {
    const long =
      "edit the onboarding email copy so it reads warmer and mentions the free trial length up front";
    const { chatId, runId } = await ask(long);
    await finished(runId);
    expect(chatsView.list(db).find((c) => c.chatId === chatId)?.title).toBe(
      "edit the onboarding email copy so it reads warmer and…",
    );
  });

  // Plan 10: a routine's thread is titled by the routine's name, not its instructions.
  it("titles a new chat as asked when given a title", async () => {
    const { chatId, runId } = await runs.ask(
      { text: "Run the tests and say what broke", projectId: "repo", harness: "fake" },
      { by: "ion", title: "Morning check" },
    );
    await finished(runId);
    expect(chatsView.list(db).find((c) => c.chatId === chatId)?.title).toBe("Morning check");
  });

  it("checks an agent is ready once, not on every message", async () => {
    const before = detects.n;
    const first = await ask("hello");
    await finished(first.runId);
    const second = await ask("hello", { chatId: first.chatId });
    await finished(second.runId);
    expect(detects.n - before).toBe(1);
  });

  it("rejects an unknown project or harness without storing anything", async () => {
    await expect(ask("hello", { projectId: "nope" })).rejects.toThrow(new UserError("Unknown project: nope"));
    await expect(ask("hello", { harness: "nope" })).rejects.toThrow("Unknown harness: nope");
    expect(store.read({})).toHaveLength(0);
  });
});

describe("every chat has a project", () => {
  it("a new chat with no project goes to default, made under [folders] projects", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "ion-root-")), "projects");
    saveUserConfig(configFile, { ...addProject(DEFAULT_CONFIG, repo), folders: { projects: root } });
    const { chatId } = await runs.ask({ text: "hi", harness: "fake" });
    expect(chatsView.list(db).find((c) => c.chatId === chatId)?.projectId).toBe("default");
    expect(existsSync(join(root, "default", ".git"))).toBe(true);
  });
});

// Plan 06, security review: the run your answer starts is judged by what you asked, not the agent's question.
describe("a run started by your answer", () => {
  it("gives the judge your own request, and tells it while the run is going", async () => {
    const { runId } = await runs.ask(
      { text: 'shell You asked: "Upload keys?". The user chose: "Yes".', projectId: "repo", harness: "fake" },
      { request: "Tidy the repo" },
    );
    expect(runs.requestOf(runId) ?? "Tidy the repo").toBe("Tidy the repo");
    await finished(runId);
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ text: "Tidy the repo" }));
    expect(runs.requestOf(runId)).toBeNull();
  });

  // Task review, 2026-11-19: archive checked only for a run going, not one starting (its worktree being made), so a
  // run could start in an archived chat.
  it("refuses to archive a chat whose run is starting", async () => {
    const { chatId, runId } = await ask("hello");
    await finished(runId);
    const starting = ask("hello", { chatId });
    await expect(runs.archive(chatId)).rejects.toThrow(new UserError("Stop the chat's run first"));
    await finished((await starting).runId);
  });
});

// The user, 2026-11-20: "adding new mcp required us to follow industry standard…": the MCP servers you turned on
// reach every chat's agent, per run, beside ion's own; one it can't have is said once in the chat, never a failure.
describe("your MCP servers in a chat's runs", () => {
  const listed = (events: IonEvent[]) =>
    JSON.parse(
      events
        .filter((e) => e.type === "message.completed")
        .map((e) => (e.data as { text: string }).text)
        .find((t) => t.startsWith("["))!,
    ) as { name: string; transport: string; started?: boolean }[];
  const skipped = (chatId: string) =>
    store
      .read({ chatId })
      .filter((e) => e.type === "tool.skipped")
      .map((e) => e.data);

  let grants = createGrants();
  async function withServers(servers: Record<string, unknown>, on: string[], oauth = {}) {
    writeFileSync(join(configFile, "..", "mcp.json"), JSON.stringify({ mcpServers: servers }));
    const tools = createTools({ configFile, secrets: memorySecrets() });
    await setOn(tools, on);
    const o = { status: async () => null, freshToken: async () => null, ...oauth };
    grants = createGrants();
    runs = new RunManager(
      store,
      {
        ...{ configFile, dataDir, random: () => 0, access },
        mcp: { grants, url: () => "http://127.0.0.1:9/mcp" },
        servers: serversFor({ tools, oauth: o, configFile }),
      },
      needs,
      db,
    );
    return tools;
  }
  async function setOn(tools: ReturnType<typeof createTools>, on: string[]) {
    const all = tools.read().servers;
    const mcpOn = await Promise.all(
      on.map(async (n) => `${n}@${await tools.consent(all.find((s) => s.name === n)!)}`),
    );
    const c = loadUserConfig(configFile).config;
    saveUserConfig(configFile, { ...c, tools: { ...c.tools, mcpOn } });
  }

  it("gives each chat run ion's server first, then yours that are on", async () => {
    await withServers(
      { docs: { command: process.execPath, args: ["-e", "setTimeout(()=>{},5000)"] }, off: { command: "x" } },
      ["docs"],
    );
    const events = await finished((await ask("mcplist")).runId);
    // A local one is ion's to start (Task 3b): the agent reaches it at ion's URL.
    expect(listed(events)).toEqual([
      { name: "ion", transport: "http" },
      { name: "docs", transport: "http" },
    ]);
    expect(events.at(-1)?.data).toEqual({ status: "done" });
  });

  // Review Focus 1, and the user, 2026-11-20 (ion as gateway, "In Plan 18 now"): a local server that won't start
  // (or crashes) is said once in the chat; requests to it get a JSON-RPC error and the run goes on.
  it("a crash is said once and the run goes on", async () => {
    await withServers({ broken: { command: "/nonexistent/ion-no-such-server" } }, ["broken"]);
    const { chatId, runId } = await ask("slow");
    await until(() => store.read({ runId }).some((e) => e.type === "tool.started"));
    const local = runs.upstream(runId, "broken") as { send(m: object): Promise<{ error?: object }> };
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    expect((await local.send(list)).error).toMatchObject({ code: -32000 });
    expect((await local.send({ ...list, id: 2 })).error).toMatchObject({ code: -32000 });
    expect(store.read({ runId }).some((e) => e.type === "run.finished" || e.type === "error")).toBe(false);
    await runs.stopChat(chatId);
    await finished(runId);
    expect(skipped(chatId)).toEqual([
      // Task review, 2026-11-21: one that never started says so.
      { id: "broken", text: "broken couldn't start, so this chat goes on without it." },
    ]);
  });

  // The user, 2026-11-20 (ion as gateway, "In Plan 18 now"): ion starts your local servers itself; the agent gets
  // only ion's URL for them and the run's key.
  it("a stdio server is started by ion with its env, never by the agent", async () => {
    const tiny = fileURLToPath(new URL("../workspace/fixtures/tiny-mcp.mjs", import.meta.url));
    await withServers(
      { tiny: { command: process.execPath, args: [tiny], env: { TINY_KEY: "${TINY_TEST_KEY_3B}" } } },
      ["tiny"],
    );
    process.env.TINY_TEST_KEY_3B = "key-secret-3b";
    started.length = 0;
    try {
      const { runId } = await ask("slow");
      await until(() => store.read({ runId }).some((e) => e.type === "tool.started"));
      const given = started[0]!.mcpServers as { name: string; headers: Record<string, string> }[];
      const auth = given[0]!.headers.Authorization!;
      expect(given[1]).toEqual({
        name: "tiny",
        transport: "http",
        url: "http://127.0.0.1:9/mcp/s/tiny",
        headers: { Authorization: auth },
      });
      const local = runs.upstream(runId, "tiny") as { send(m: object): Promise<unknown> };
      const who = (await local.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "whoami", arguments: {} },
      })) as { result: { content: { text: string }[] } };
      const me = JSON.parse(who.result.content[0]!.text) as {
        ppid: number;
        pid: number;
        env: Record<string, string>;
      };
      expect(me.ppid).toBe(process.pid);
      expect(me.env.TINY_KEY).toBe("key-secret-3b");
      await runs.stopChat(store.read({ runId })[0]!.chatId!);
      await finished(runId);
      // PR A verification, 2026-11-21: on a loaded machine the server's exit lands just after the run's end event
      // (pnpm check failed twice this way); it must be gone within a few seconds.
      await vi.waitFor(() => expect(() => process.kill(me.pid, 0)).toThrow(), { timeout: 5000 });
    } finally {
      delete process.env.TINY_TEST_KEY_3B;
    }
  });

  // The user, 2026-11-20 (ion as gateway, "In Plan 18 now"): no command, args or env of yours reaches any agent.
  it("no command/args/env in any agent's MCP config", async () => {
    await withServers(
      {
        docs: {
          command: "docs-mcp",
          args: ["--token", "${DOCS_TEST_ARG_3B}"],
          env: { T: "${DOCS_TEST_ENV_3B}" },
        },
        remote: { type: "http", url: "https://docs.example/mcp", headers: { "X-K": "remote-key-3b" } },
      },
      ["docs", "remote"],
    );
    Object.assign(process.env, { DOCS_TEST_ARG_3B: "arg-secret-3b", DOCS_TEST_ENV_3B: "env-secret-3b" });
    started.length = 0;
    try {
      await finished((await ask("hello")).runId);
    } finally {
      delete process.env.DOCS_TEST_ARG_3B;
      delete process.env.DOCS_TEST_ENV_3B;
    }
    const given = started[0]!.mcpServers as Record<string, unknown>[];
    expect(given.map((s) => Object.keys(s).sort())).toEqual([
      ["headers", "name", "transport", "url"],
      ["headers", "name", "transport", "url"],
      ["headers", "name", "transport", "url"],
    ]);
    expect(JSON.stringify(started)).not.toMatch(/docs-mcp|arg-secret-3b|env-secret-3b|remote-key-3b|--token/);
  });

  // Review Focus 1: not signed in or no key: the chat runs without it, said once in the chat, never a failed run.
  it("runs without a server that isn't signed in or has no key, and says so once in the chat", async () => {
    await withServers(
      {
        github: { type: "http", url: "https://api.githubcopilot.com/mcp" },
        stripe: { command: "stripe-mcp", env: { STRIPE_KEY: "${ION_TEST_NO_SUCH_KEY}" } },
      },
      ["github", "stripe"],
      { status: async () => "sign in" as const },
    );
    const first = await ask("mcplist");
    const a = await finished(first.runId);
    expect(a.at(-1)?.data).toEqual({ status: "done" });
    expect(listed(a).map((s) => s.name)).toEqual(["ion"]);
    await finished((await ask("mcplist", { chatId: first.chatId })).runId);
    expect(skipped(first.chatId)).toEqual([
      { id: "github", text: "github isn't signed in, so this chat runs without it." },
      { id: "stripe", text: "stripe needs a key, so this chat runs without it." },
    ]);
  });

  // Review Focus 2: a token or a key reaches the agent, never the chat's events.
  it("keeps keys and tokens out of the event log", async () => {
    await withServers(
      {
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        docs: { command: "docs-mcp", env: { TOKEN: "${DOCS_TEST_KEY_T3}" } },
      },
      ["linear", "docs"],
      { status: async () => "signed in" as const, freshToken: async () => "tok-secret-1" },
    );
    process.env.DOCS_TEST_KEY_T3 = "key-secret-2";
    try {
      const { chatId, runId } = await ask("hello");
      await finished(runId);
      const log = JSON.stringify(store.read({ chatId }));
      expect(log).not.toContain("tok-secret-1");
      expect(log).not.toContain("key-secret-2");
    } finally {
      delete process.env.DOCS_TEST_KEY_T3;
    }
  });

  it("runs without a server the agent can't take, and says so", async () => {
    process.env.ION_FAKE_NO_HTTP = "1";
    try {
      await withServers(
        { linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { "X-K": "k" } } },
        ["linear"],
      );
      const { chatId, runId } = await ask("mcplist");
      expect((await finished(runId)).at(-1)?.data).toEqual({ status: "done" });
      expect(skipped(chatId)).toEqual([
        { id: "linear", text: "Fake can't use linear, so this chat runs without it." },
      ]);
    } finally {
      delete process.env.ION_FAKE_NO_HTTP;
    }
  });

  // Turning a server off mid-run: the run keeps what it started with (its retries too); the next run goes without.
  it("keeps a run's servers when you turn one off mid-run; the next run goes without it", async () => {
    const tools = await withServers({ docs: { command: process.execPath, args: ["-e", "0"] } }, ["docs"]);
    const first = await ask("mcplist retry-once");
    await until(() => store.read({ runId: first.runId }).some((e) => e.type === "message.completed"));
    await setOn(tools, []);
    const a = await finished(first.runId);
    const lists = a
      .filter((e) => e.type === "message.completed")
      .map((e) => (JSON.parse((e.data as { text: string }).text) as { name: string }[]).map((s) => s.name));
    expect(lists).toEqual([
      ["ion", "docs"],
      ["ion", "docs"],
    ]);
    const next = await finished((await ask("mcplist", { chatId: first.chatId })).runId);
    expect(listed(next).map((s) => s.name)).toEqual(["ion"]);
  });

  // The user, 2026-11-20 ("In Plan 18 now"): ion is the gateway to your remote servers; an agent holds only ion's
  // URLs and the run's key, never your keys or tokens.
  it("an agent's config holds only ion URLs and the run key", async () => {
    await withServers(
      {
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        docs: {
          type: "http",
          url: "https://docs.example/mcp",
          headers: { "X-Api-Key": "${DOCS_TEST_KEY_3A}" },
        },
      },
      ["linear", "docs"],
      { status: async () => "signed in" as const, freshToken: async () => "tok-secret-3a" },
    );
    process.env.DOCS_TEST_KEY_3A = "key-secret-3a";
    started.length = 0;
    try {
      await finished((await ask("hello")).runId);
    } finally {
      delete process.env.DOCS_TEST_KEY_3A;
    }
    const given = started[0]!.mcpServers as { name: string; url: string; headers: Record<string, string> }[];
    const auth = given[0]!.headers.Authorization!;
    expect(auth).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(given).toEqual([
      { name: "ion", transport: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: auth } },
      {
        name: "linear",
        transport: "http",
        url: "http://127.0.0.1:9/mcp/s/linear",
        headers: { Authorization: auth },
      },
      {
        name: "docs",
        transport: "http",
        url: "http://127.0.0.1:9/mcp/s/docs",
        headers: { Authorization: auth },
      },
    ]);
    expect(JSON.stringify(started)).not.toMatch(/tok-secret-3a|key-secret-3a|linear\.app|docs\.example/);
  });

  // Task review, 2026-11-20: a key filled from ion's environment reached the agent through its inherited env.
  it("a ${NAME} filled from ion's env is absent from the agent's env", async () => {
    await withServers(
      {
        docs: {
          type: "http",
          url: "https://docs.example/mcp",
          headers: { "X-Api-Key": "${DOCS_TEST_ENV_3A}" },
        },
        off: { command: "off-mcp", env: { T: "${OFF_TEST_ENV_3A}" } },
      },
      ["docs"],
    );
    Object.assign(process.env, {
      DOCS_TEST_ENV_3A: "key-secret-env-1",
      OFF_TEST_ENV_3A: "key-secret-env-2",
      COPY_TEST_ENV_3A: "key-secret-env-1",
      PLAIN_TEST_ENV_3A: "fine",
    });
    try {
      const events = await finished((await ask("inherits")).runId);
      const text = events.find((e) => e.type === "message.completed")?.data as { text: string };
      expect(JSON.parse(text.text)).toEqual(["PLAIN_TEST_ENV_3A"]);
    } finally {
      for (const k of ["DOCS", "OFF", "COPY", "PLAIN"]) delete process.env[`${k}_TEST_ENV_3A`];
    }
  });

  it("the run key stops working at ion's gateway when the run ends", async () => {
    await withServers({ docs: { type: "http", url: "https://docs.example/mcp", headers: { "X-K": "k" } } }, [
      "docs",
    ]);
    started.length = 0;
    const { chatId, runId } = await ask("slow");
    await until(() => store.read({ runId }).some((e) => e.type === "tool.started"));
    const key = (
      started[0]!.mcpServers![1] as { headers: { Authorization: string } }
    ).headers.Authorization.slice(7);
    expect(grants.check(key)).toMatchObject({ kind: "run", runId });
    expect(runs.upstream(runId, "docs")?.url).toBe("https://docs.example/mcp");
    expect(runs.upstream(runId, "other")).toBeNull();
    await runs.stopChat(chatId);
    await finished(runId);
    expect(grants.check(key)).toBeNull();
    expect(runs.upstream(runId, "docs")).toBeNull();
    const call = { toolName: "echo", kind: "mcp", mcpServer: "docs", summary: "echo", input: {} };
    expect((await runs.gateMcp(runId, call)).decision).toBe("deny");
  });
});

// Task review, 2026-11-20: an agent can print its environment or its MCP servers' (`env`, `ps eww`), and its words go
// to the chat's history as it says them. Every key, token and ion key of the run is redacted before it's stored.
describe("a run's keys never reach ion's history", () => {
  it("redacts the run's keys, tokens and ion key in thinking, tool input and output, and messages", async () => {
    writeFileSync(
      join(configFile, "..", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          linear: { type: "http", url: "https://mcp.linear.app/mcp" },
          docs: { command: "docs-mcp", env: { DOCS_TOKEN: "${DOCS_TEST_KEY_T3}" } },
        },
      }),
    );
    const tools = createTools({ configFile, secrets: memorySecrets() });
    const all = tools.read().servers;
    const mcpOn = await Promise.all(all.map(async (s) => `${s.name}@${await tools.consent(s)}`));
    const c = loadUserConfig(configFile).config;
    saveUserConfig(configFile, { ...c, tools: { ...c.tools, mcpOn } });
    const oauth = { status: async () => "signed in" as const, freshToken: async () => "tok-secret-1234" };
    const grants = createGrants();
    const keys: string[] = [];
    const create = grants.create.bind(grants);
    grants.create = (...a: Parameters<typeof create>) => {
      const k = create(...a);
      keys.push(k);
      return k;
    };
    runs = new RunManager(
      store,
      {
        ...{ configFile, dataDir, random: () => 0, access },
        mcp: { grants, url: () => "http://127.0.0.1:9/mcp" },
        servers: serversFor({ tools, oauth, configFile }),
      },
      needs,
      db,
    );
    process.env.DOCS_TEST_KEY_T3 = "key-secret-5678";
    try {
      const { chatId, runId } = await ask("leak");
      expect((await finished(runId)).at(-1)?.data).toEqual({ status: "done" });
      const log = JSON.stringify(store.read({ chatId }));
      for (const secret of ["tok-secret-1234", "key-secret-5678", ...keys]) expect(log).not.toContain(secret);
      // linear's header is ion's gateway's now: the run's key, never your token (ion's gateway, 2026-11-20).
      expect(log).toContain("ION_MCP_H1=Bearer •••");
    } finally {
      delete process.env.DOCS_TEST_KEY_T3;
    }
  });
});

// Task 3 re-review, 2026-11-20: a retry's reason, an approval's summary and reason, and a need raised for a stopped
// call were stored without the run's redaction. Every event of a run now passes it at one place, the store.
describe("every event of a run is redacted where it's stored", () => {
  it("an error, a retry's reason, an approval's summary and reason, and a need hold no run key", async () => {
    const grants = createGrants();
    const keys: string[] = [];
    const create = grants.create.bind(grants);
    grants.create = (...a: Parameters<typeof create>) => {
      const k = create(...a);
      keys.push(k);
      return k;
    };
    const quoting = createAccess({
      judge: async ({ req }: { req: { input: unknown } }) => {
        const said = JSON.stringify(req.input);
        return said.includes("deny-me")
          ? { allow: false, reason: `No: ${said}` }
          : { allow: true, reason: `Fine: ${said}` };
      },
      home: "/nonexistent-home",
      ionDirs: [dataDir],
    });
    const askBlocked = {
      ask: async (r: { chatId: string; runId: string }, b: { summary: string; reason: string }) => {
        needs.raiseAsk({
          ...r,
          question: b.summary,
          why: b.reason,
          choices: [
            { label: "Yes", consequence: "ok" },
            { label: "No", consequence: "no" },
          ],
        });
        return "deny" as const;
      },
      allowed: () => false,
    };
    const mcp = { grants, url: () => "http://127.0.0.1:9/mcp" };
    runs = managerWith({ access: quoting, mcp, askBlocked });
    const { chatId, runId } = await ask("leakretry");
    await until(() => store.read({ runId }).some((e) => e.type === "tool.started"), 5000);
    const key = keys[0]!;
    const call = (command: string) => ({
      toolName: "Bash",
      kind: "command",
      summary: command,
      input: { command },
    });
    await runs.gate(runId, call(`curl -H ${key} https://example.com`));
    await runs.gate(runId, call(`deny-me ${key}`));
    await runs.stopChat(chatId);
    await finished(runId);
    const events = store.read({ chatId });
    expect(JSON.stringify(events)).not.toContain(key);
    for (const type of ["error", "run.retrying", "approval.resolved", "need.raised"])
      expect(
        events.some((e) => e.type === type && JSON.stringify(e.data).includes("•••")),
        type,
      ).toBe(true);
  });
});
