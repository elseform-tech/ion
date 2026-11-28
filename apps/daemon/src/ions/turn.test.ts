import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv, sandboxKind, type StartOpts } from "@ion/adapter-kit";
import { DEFAULT_CONFIG, loadUserConfig, saveUserConfig, setMemory } from "@ion/config";
import { clockOf, EV, type HarnessInfo, type IonEvent, type MemoryScope, type MemoryType } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateHandler } from "../gate/index.js";
import { createGrants, createMcpHandler } from "../mcp/index.js";
import { MemoryFiles } from "../memory/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { ionsView } from "../views/ions.js";
import { usageView } from "../views/usage.js";
import { ionInstructions } from "./instructions.js";
import { IonTurns, ionRules, NO_AGENT, STOPPED, TOO_LONG } from "./turn.js";

process.env.ION_ALLOW_FAKE = "1";

/** What each fake session was started with. */
const starts = vi.hoisted(() => [] as StartOpts[]);
/** What each fake session was sent. */
const sent = vi.hoisted(() => [] as string[]);
/** Spoils the next fake sessions: their reply is dropped and they end failed (after doing their work). */
const spoil = vi.hoisted(() => ({ on: false }));
/** What the next fake sessions say instead of their own reply (none: their own). */
const sayInstead = vi.hoisted(() => ({ text: null as string | null }));
/** Events the next fake sessions report just before they end (an agent's usage, its limit). */
const inject = vi.hoisted(() => ({ events: [] as { type: string; data: Record<string, unknown> }[] }));
vi.mock("@ion/adapter-fake", async (real) => {
  const m = await real<typeof import("@ion/adapter-fake")>();
  return {
    ...m,
    createFakeAdapter: (...a: Parameters<typeof m.createFakeAdapter>) => {
      const adapter = m.createFakeAdapter(...a);
      const start = adapter.start.bind(adapter);
      adapter.start = async (o) => {
        starts.push(o);
        const session = await start(o);
        const send = session.send.bind(session);
        session.send = (m) => {
          sent.push(m.text);
          return send(m);
        };
        if (sayInstead.text !== null) {
          const said = sayInstead.text;
          const own = session.events.bind(session);
          session.events = async function* () {
            for await (const e of own())
              yield e.type === EV.messageCompleted ? ({ ...e, data: { text: said } } as typeof e) : e;
          };
        }
        if (inject.events.length) {
          const own = session.events.bind(session);
          session.events = async function* () {
            for await (const e of own()) {
              if (e.type === EV.runFinished) for (const x of inject.events) yield x as typeof e;
              yield e;
            }
          };
        }
        if (!spoil.on) return session;
        const events = session.events.bind(session);
        session.events = async function* () {
          for await (const e of events()) {
            if (e.type === EV.messageCompleted) continue;
            yield e.type === EV.runFinished ? { ...e, data: { status: "failed" } } : e;
          }
        };
        return session;
      };
      return adapter;
    },
  };
});

// The user, 2026-11-19: "ions require tools, reasoning and their harness power… rather than cheap and quick, i would
// rather it finishes task accurately, securely, with high quality with some cost". An ion's turn is now a real agent
// session (here the fake agent's `ion` scenario) with ion's tools over MCP and a gate that only lets it read.

let db: Db;
let store: EventStore;
let http: Server;
let base: string;
let home: string;
let repo: string;
let signedIn: boolean;
let startThread: ReturnType<typeof vi.fn>;
let current: IonTurns;
/** Every IonTurns a test made: each is shut down before its server closes. */
let made: IonTurns[] = [];

const agents = async (): Promise<HarnessInfo[]> => [
  { id: "fake", label: "Fake", installed: true, signedIn, models: [], defaultModel: "fake" },
];

/** The fake agent, and opencode ready too (it can't start here: real agents are off in tests). */
const both = async (): Promise<HarnessInfo[]> => [
  ...(await agents()),
  { id: "opencode", label: "opencode", installed: true, signedIn: true, models: [], defaultModel: null },
];

/** A public address (a CDN's), built rather than written out. */
const PUBLIC_IP = [104, 20, 22, 46].join(".");

function turns(turnMs?: number, more: Partial<ConstructorParameters<typeof IonTurns>[0]> = {}): IonTurns {
  current = new IonTurns({
    ...{ store, db, configFile: join(home, "config.toml"), dataDir: join(home, "data") },
    grants,
    mcpUrl: () => `${base}/mcp`,
    gateUrl: () => `${base}/gate`,
    agents,
    startThread,
    home,
    // Every name is a public address here (no real DNS in tests).
    dns: async () => [{ address: PUBLIC_IP, family: 4 }],
    ...(turnMs ? { turnMs } : {}),
    ...more,
  });
  made.push(current);
  return current;
}

let grants: ReturnType<typeof createGrants>;
let memory: MemoryFiles;

beforeEach(async () => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  home = mkdtempSync(join(tmpdir(), "ion-turn-"));
  repo = mkdtempSync(join(tmpdir(), "ion-turn-repo-"));
  saveUserConfig(join(home, "config.toml"), {
    ...DEFAULT_CONFIG,
    ion: { ...DEFAULT_CONFIG.ion, quick: "fake" },
    projects: [
      { id: "storefront", path: repo, starred: false, harness: "fake" },
      { id: "payments-api", path: "/p/payments-api", starred: false, harness: "fake" },
      { id: "private", path: "/p/private", starred: false, shareWithIon: false },
      { id: "default", path: "/p/default", starred: false },
    ],
  });
  signedIn = true;
  grants = createGrants();
  startThread = vi.fn(async (projectId: string) => ({ chatId: `t-${projectId}` }));
  const configFile = join(home, "config.toml");
  memory = new MemoryFiles({ root: join(home, "data", "memory"), store, db });
  const mcp = createMcpHandler({
    ...{ store, db, grants, configFile, memory },
    startThread: (p, b, t) => current.startThread(p, b, t),
  });
  const gate = createGateHandler({
    grants,
    decide: async () => null,
    ion: (scope, payload) => current.gate(scope, payload),
  });
  http = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/gate/")) void gate(req, res);
    else void mcp(req, res);
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const addr = http.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

// Task review, 2026-11-19: a turn still running when the server closed got ECONNRESET, unhandled, and failed the
// run. Its turns end first.
afterEach(async () => {
  inject.events = [];
  sayInstead.text = null;
  await Promise.all(made.map((t) => t.shutdown()));
  made = [];
  http.closeAllConnections();
  await new Promise((r) => http.close(r));
});

const onIon = (ionId: string) => store.read({ chatId: `ion:${ionId}` });

describe("an ion's turn", () => {
  // Review, 2026-11-22: with its only agent limited (a stated reset) an ion said "I couldn't reach my agent". It says
  // which agent frees up first, and when.
  // Review, 2026-11-22: an ion's turn that went well on an agent marked limited by ion's guess clears the mark.
  it("a successful ion turn started after the mark clears it", async () => {
    const data = { code: "usage_limit", retryable: false, message: "x", limit: {}, harness: "fake" };
    store.append({ chatId: null, runId: null, origin: "adapter", type: EV.error, data });
    expect(usageView.agents(db, new Date()).fake?.limitGuessed).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const r = await turns().turn("chief", "hello");
    expect(r.reply).not.toContain("limited");
    expect(usageView.agents(db, new Date()).fake?.limitedUntil).toBeNull();
  });

  // Security scan, 2026-11-22: a reply worded like ion's own failure line was taken as ion's ("no agent"). Only ion
  // marks its own lines; an agent's words are its answer, whatever they say.
  it("an agent replying like ion's own failure line is a normal answer", async () => {
    for (const text of ["Codex is limited until 16:00", "I couldn't reach my agent: no"]) {
      sayInstead.text = text;
      const r = await turns().turn("chief", "hello");
      expect(r.reply).toBe(text);
      expect(r.ionLine).toBeUndefined();
    }
    sayInstead.text = "";
    expect((await turns().turn("chief", "hello")).ionLine).toBe("no-agent");
  });

  it("all agents limited: says when the first frees up", async () => {
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    const data = {
      code: "usage_limit",
      retryable: false,
      message: "x",
      limit: { resetsAt },
      harness: "fake",
    };
    store.append({ chatId: null, runId: null, origin: "adapter", type: EV.error, data });
    const before = starts.length;
    const r = await turns().turn("chief", "hello");
    expect(r.reply).toBe(`Fake is limited until ${clockOf(resetsAt, new Date())}`);
    expect(r.ionLine).toBe("no-agent");
    expect(starts).toHaveLength(before);
  });

  // The user, 2026-11-22: what ions spend on an agent counts in its usage line, and an ion's turn that hits the agent's
  // limit marks it limited for everyone (chats and ions alike). Neither shows in the ion's chat.
  it("an ion turn's usage and limit go in its agent's usage", async () => {
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    inject.events = [
      { type: EV.usageReported, data: { model: "m", inputTokens: 30, outputTokens: 4, costUsd: 0.02 } },
      {
        type: EV.error,
        data: { code: "usage_limit", retryable: false, message: "Limit", limit: { resetsAt } },
      },
    ];
    await turns().turn("chief", "hello");
    expect(usageView.agents(db, new Date()).fake).toMatchObject({
      week: { tokens: 34, costUsd: 0.02 },
      limitedUntil: resetsAt,
    });
    expect(onIon("chief").filter((e) => e.type === EV.usageReported || e.type === EV.error)).toEqual([]);
  });

  it("a turn's last message is the reply, and the threads it started come with it", async () => {
    const text = "please check storefront and payments-api";
    const r = await turns().turn("chief", text);
    expect(r).toEqual({
      reply: "Asked 2 projects.",
      threads: [
        { chatId: "t-storefront", projectId: "storefront" },
        { chatId: "t-payments-api", projectId: "payments-api" },
      ],
      turnId: expect.stringMatching(/^turn_/),
    });
    // The judge reads your own words as the request, never the brief the ion's agent wrote.
    // No skills or mentions were named (the user, 2026-11-21: start_thread takes them).
    expect(startThread).toHaveBeenCalledWith(
      "storefront",
      text,
      { ionId: "chief", request: text, turnId: expect.stringMatching(/^turn_/) },
      undefined,
    );
    // Its work is kept on its chat under the turn's id, for the app to draw.
    const work = onIon("chief").filter((e: IonEvent) => e.type === EV.toolStarted);
    expect(work.map((e) => (e.data as { name: string }).name)).toEqual([
      "mcp__ion__projects",
      "mcp__ion__start_thread",
      "mcp__ion__start_thread",
    ]);
    expect(new Set(work.map((e) => e.runId)).size).toBe(1);
    // Task review, 2026-11-19: the turn's id comes with its reply, so the reply can carry it (its work goes above it).
    expect(work[0]!.runId).toBe(r.turnId);
  });

  // The user, 2026-11-20: your MCP servers reach chats' agents only; an ion's own turn has ion's server alone.
  // The user, 2026-11-21: ions find memory through a quick index and read the details on demand. Each turn starts
  // with the index of what that ion may see.
  // Task review, 2026-11-22: ion's dream never searches the web. Its turn starts with the web off (and a daemon-only
  // folder for the agent's own files); on an agent that can't turn its web off, it doesn't start at all.
  it("a dream's turn starts with its web off, or not at all", async () => {
    const dream = { pass: { see: "ions" as const }, max: 30, ms: 60_000 };
    // PR #36 re-review (I1), 2026-11-23: Dream's agent is [memory] dreamAgent, never ion's brain.
    const configFile = join(home, "config.toml");
    const c = loadUserConfig(configFile).config;
    saveUserConfig(configFile, { ...c, memory: { ...c.memory, dreamAgent: "fake" } });
    await turns().turn("_dream", "Tidy memory.", { noThreads: true, dream });
    const o = starts.at(-1)!;
    expect(o.noWeb).toBe(true);
    expect(o.bareHome).toBe(join(home, "data", "ions", "_dream-own"));
    expect(o.mcpServers?.map((m) => m.name)).toEqual(["ion"]);
    process.env.ION_FAKE_HAS_WEB = "1";
    try {
      const before = starts.length;
      const r = await turns().turn("_dream", "Tidy memory.", { noThreads: true, dream });
      expect(r.reply).toBe("Tidy memory skipped: Fake can't turn its web off");
      expect(starts).toHaveLength(before);
    } finally {
      delete process.env.ION_FAKE_HAS_WEB;
    }
  });

  it("an ion's turn starts with its index", async () => {
    const memory = new MemoryFiles({ root: join(home, "data", "memory"), store, db });
    const w = (scope: MemoryScope, name: string, type: MemoryType) =>
      memory.write({ scope, header: { name, description: name, type }, text: name, by: "you" });
    w("you", "Home city", "person");
    w({ projectId: "storefront" }, "Deploy day", "fact");
    w({ projectId: "payments-api" }, "Rate limits", "fact");
    sent.length = 0;
    await turns(undefined, { memory }).turn("storefront", "hello");
    const text = sent.at(-1) ?? "";
    expect(text).toMatch(/^<ion-data id="\w+" source="ion's memory index">\n/);
    expect(text).toContain("you/home-city.md");
    expect(text).toContain("projects/storefront/deploy-day.md");
    expect(text).not.toContain("payments-api");
    expect(text.endsWith("\n\nhello")).toBe(true);
  });

  // The user, 2026-11-23: memory off: no tools, no list, nothing written; per project off hides your personal memory
  // from that project too. An ion's turn gets no index and no word of memory in its instructions when its memory is
  // off; ion chief's index leaves out a project that's off; a session given memory isn't resumed without it.
  it("memory off: no tools, no list, nothing written", async () => {
    const memory = new MemoryFiles({ root: join(home, "data", "memory"), store, db });
    const w = (scope: MemoryScope, name: string) =>
      memory.write({ scope, header: { name, description: name, type: "fact" }, text: name, by: "you" });
    w("you", "Home city");
    w({ projectId: "storefront" }, "Deploy day");
    w({ projectId: "payments-api" }, "Rate limits");
    const file = join(home, "config.toml");
    const c = loadUserConfig(file).config;
    const scopes: unknown[] = [];
    const create = grants.create.bind(grants);
    grants.create = (s, k) => (scopes.push(s), create(s, k));
    const t = turns(undefined, { memory });
    sent.length = 0;
    await t.turn("storefront", "hello");
    expect(sent.at(-1)?.startsWith("<ion-data")).toBe(true);
    saveUserConfig(file, setMemory(c, false, "storefront"));
    await t.turn("storefront", "remind me to ship on 2026-12-01");
    expect(sent.at(-1)).toBe("remind me to ship on 2026-12-01");
    expect(starts.at(-1)?.instructions).not.toMatch(/memory|to-dos/i);
    expect(starts.at(-1)?.resume).toBeUndefined();
    expect(scopes.at(-1)).toMatchObject({ memory: { you: false, projects: [] } });
    expect(memory.list(null, ["chats", "ions"]).some((m) => m.type === "todo")).toBe(false);
    await t.turn("chief", "hello");
    const chief = sent.at(-1) ?? "";
    expect([
      chief.includes("home-city"),
      chief.includes("rate-limits"),
      chief.includes("deploy-day"),
    ]).toEqual([true, true, false]);
    saveUserConfig(file, setMemory(c, false));
    await t.turn("chief", "hello");
    expect(sent.at(-1)).toBe("hello");
    expect(starts.at(-1)?.instructions).not.toMatch(/memory/i);
  });

  // Task review, 2026-11-22 (M-5): every turn repeated the index into a resumed session. It goes in once per session,
  // and again only when it changed.
  it("a resumed session gets the index again only when it changed", async () => {
    const memory = new MemoryFiles({ root: join(home, "data", "memory"), store, db });
    const w = (name: string) =>
      memory.write({
        scope: { projectId: "storefront" },
        header: { name, description: name, type: "fact" },
        text: name,
        by: "you",
      });
    w("Deploy day");
    const t = turns(undefined, { memory });
    sent.length = 0;
    await t.turn("storefront", "hello");
    await t.turn("storefront", "hello again");
    w("Rate limits");
    await t.turn("storefront", "and again");
    expect(sent.map((x) => x.startsWith("<ion-data"))).toEqual([true, false, true]);
    expect(starts.at(-1)?.resume).toBeTruthy();
  });

  it("an ion's turn gets only ion's server, never yours", async () => {
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "docs-mcp" } } }));
    const c = loadUserConfig(join(home, "config.toml")).config;
    saveUserConfig(join(home, "config.toml"), { ...c, tools: { ...c.tools, mcpOn: ["docs@any"] } });
    await turns().turn("payments-api", "what is this");
    expect(starts.at(-1)?.mcpServers).toEqual([
      {
        name: "ion",
        transport: "http",
        url: `${base}/mcp`,
        headers: { Authorization: expect.stringMatching(/^Bearer [0-9a-f]{64}$/) },
      },
    ]);
  });

  // Final review, 2026-11-22: ion's own agent processes started outside the OS sandbox; on Grok and opencode they keep
  // their tools and load their plugins. An ion's turn starts in a run's sandbox: ion's data folder denied (its own
  // folder there let through), agents' configs read-only.
  it.skipIf(sandboxKind() === "none")("an ion's turn starts in a run's sandbox", async () => {
    await turns().turn("chief", "hello");
    const s = starts.at(-1)!;
    expect(s.sandbox?.paths.deny).toContain(join(home, "data"));
    expect(s.sandbox?.paths.write).toEqual([s.cwd]);
    expect(s.sandbox?.paths.noWrite.length).toBeGreaterThan(0);
  });

  // Task review, 2026-11-20: ion's own agents (an ion's turn, the judge, the probes) inherited ion's environment, and
  // with it a key mcp.json fills from there.
  it("an ion turn's agent env lacks a ${NAME} filled from ion's env", async () => {
    writeFileSync(
      join(home, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          docs: { type: "http", url: "https://d.example/mcp", headers: { K: "${TURN_TEST_KEY}" } },
        },
      }),
    );
    Object.assign(process.env, {
      TURN_TEST_KEY: "turn-secret-123",
      TURN_TEST_COPY: "turn-secret-123",
      TURN_TEST_PLAIN: "x",
    });
    try {
      await turns().turn("payments-api", "what is this");
      const env = agentEnv(process.env, starts.at(-1)?.envDrop);
      expect(Object.keys(env).filter((k) => k.startsWith("TURN_TEST_"))).toEqual(["TURN_TEST_PLAIN"]);
    } finally {
      for (const k of ["KEY", "COPY", "PLAIN"]) delete process.env[`TURN_TEST_${k}`];
    }
  });

  // Task review, 2026-11-21: `${HOME}` in mcp.json took HOME from every agent (Claude lost its login).
  it("`${HOME}/docs` in mcp.json leaves HOME and PATH in the agent's env; ${GH_TOKEN} is still left out", async () => {
    const servers = {
      docs: { command: "docs-mcp", args: ["${HOME}/docs"], env: { P: "${PATH}" } },
      gh: { type: "http", url: "https://gh.example/mcp", headers: { Authorization: "Bearer ${GH_TOKEN}" } },
    };
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: servers }));
    process.env.GH_TOKEN = "gh-secret-12345";
    try {
      await turns().turn("payments-api", "what is this");
      const env = agentEnv(process.env, starts.at(-1)?.envDrop);
      expect(env.HOME).toBe(process.env.HOME);
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.GH_TOKEN).toBeUndefined();
    } finally {
      delete process.env.GH_TOKEN;
    }
  });

  // Task review, 2026-11-19: run as the second project, so a scope mix-up (all projects) would answer "storefront".
  it("a project's ion sees only its project", async () => {
    const r = await turns().turn("payments-api", "what is this");
    expect(r).toEqual({ reply: "This is payments-api.", threads: [], turnId: expect.any(String) });
  });

  it("ion chief can't start a chat in a project kept from it", async () => {
    const r = await turns().turn("chief", "please check private");
    expect(startThread).not.toHaveBeenCalled();
    expect(r.threads).toEqual([]);
  });

  // Task review, 2026-11-19: `default` pools chats without a project; it has no ion and gets no threads.
  it("ion chief can't start a chat in default", async () => {
    const r = await turns().turn("chief", "please check default");
    expect(startThread).not.toHaveBeenCalled();
    expect(r.threads).toEqual([]);
  });

  // Task review, 2026-11-19: a resumed session that starts fine but then fails (its context grew too long) kept
  // every later turn failing on it. A turn that fails forgets its session; the next one starts fresh.
  it("a session that fails is forgotten, and the next turn starts fresh", async () => {
    const t = turns();
    await t.turn("storefront", "hello");
    const first = ionsView.session(db, "storefront")!.nativeId;
    process.env.ION_FAKE_RESUMED_FAILS = "1";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Plan 19's checks, 2026-11-22: the agent's reason was dropped (a bare NO_AGENT, nothing in ion's log). It's
      // said once in the log, and in the reply.
      expect((await t.turn("storefront", "hello")).reply).toBe("I couldn't reach my agent: Prompt too long");
      expect(log.mock.calls.filter((c) => String(c[0]).includes("Prompt too long"))).toHaveLength(1);
      expect(ionsView.session(db, "storefront")).toBeNull();
      // Fresh: a resumed session would fail again under this switch.
      expect((await t.turn("storefront", "hello")).reply).toBe("This is storefront.");
      expect(ionsView.session(db, "storefront")!.nativeId).not.toBe(first);
    } finally {
      log.mockRestore();
      delete process.env.ION_FAKE_RESUMED_FAILS;
    }
  });

  // Task review, 2026-11-19: an adapter whose close never resolved held the turn, and that ion's later turns.
  it("a session that won't close doesn't hold the turn or the next one", async () => {
    process.env.ION_FAKE_CLOSE_HANGS = "1";
    try {
      const t = turns(100);
      expect((await t.turn("storefront", "take-your-time")).reply).toBe(TOO_LONG);
      expect((await t.turn("storefront", "hello")).reply).toBe("This is storefront.");
    } finally {
      delete process.env.ION_FAKE_CLOSE_HANGS;
    }
  }, 15_000);

  it("an ion that doesn't exist is refused", async () => {
    await expect(turns().turn("default", "hello")).rejects.toThrow("Unknown ion: default");
    await expect(turns().turn("nope", "hello")).rejects.toThrow("Unknown ion: nope");
  });

  // The user, 2026-11-21: "does memory cover todo as well". An ion adds a to-do only when you clearly ask ("remind me
  // to…"), with its date, and says so in one line. (The fake agent follows the instructions it's given.)
  it("remind me to … becomes a to-do with its date", async () => {
    const r = await turns().turn("chief", "remind me to update the README on 2026-11-27");
    expect(r.reply).toBe("Added to your to-dos: update the README (2026-11-27)");
    const f = memory.read("you/update-the-readme.md");
    expect(f).toMatchObject({
      ok: true,
      file: { header: { type: "todo", status: "open", due: "2026-11-27" } },
    });
    // Nothing asked for, nothing added.
    await turns().turn("chief", "the README needs work");
    expect(memory.paths()).toEqual(["you/update-the-readme.md"]);
  });

  it("a turn is told it's an ion", () => {
    expect(ionInstructions("chief")).toMatch(/^You are ion,/);
    expect(ionInstructions("storefront")).toMatch(/^You are ion for the project "storefront"/);
  });

  // The user, 2026-11-19: chain bash commands more often rather than running tools in parallel or one by one,
  // to scale tools and also save cost.
  it("a turn is told to chain read-only lookups into one command", () => {
    const sentence = "When you need several read-only lookups, chain them into one command with &&.";
    expect(ionInstructions("chief")).toContain(sentence);
    expect(ionInstructions("storefront")).toContain(sentence);
  });

  // Real run on Grok, 2026-11-19: ion chief answered "I can't tell from here" instead of asking the project, after ~25 denied lookups.
  it("ion chief asks the project when an answer needs its code; a project's ion reads it", () => {
    const chief = ionInstructions("chief");
    expect(chief).toContain("can't read projects' files");
    expect(chief).toMatch(/needs a project's code[^.]*start a chat in that project/);
    expect(ionInstructions("storefront")).toContain("read its project");
  });

  it("a turn resumes the ion's session", async () => {
    const t = turns();
    await t.turn("storefront", "hello");
    const first = ionsView.session(db, "storefront");
    expect(first).toMatchObject({ harness: "fake" });
    await t.turn("storefront", "hello again");
    expect(ionsView.session(db, "storefront")).toEqual(first);
    // Recorded once: a resumed session is the same one.
    expect(onIon("storefront").filter((e: IonEvent) => e.type === EV.ionSession)).toHaveLength(1);
  });

  // Review Focus 3: two messages at once never run two sessions resuming the same native id.
  it("a second message waits for the first turn", async () => {
    const t = turns(300);
    const [a, b] = await Promise.all([t.turn("storefront", "take-your-time"), t.turn("storefront", "hello")]);
    expect(a.reply).toBe(TOO_LONG);
    expect(b.reply).toBe("This is storefront.");
    const work = onIon("storefront").filter((e: IonEvent) => e.type === EV.toolStarted);
    const firstTurn = work[0]!.runId;
    const lastOfFirst = work.findLastIndex((e) => e.runId === firstTurn);
    const firstOfSecond = work.findIndex((e) => e.runId !== firstTurn);
    expect(lastOfFirst).toBeLessThan(firstOfSecond);
    expect(onIon("storefront").filter((e: IonEvent) => e.type === EV.ionSession)).toHaveLength(1);
  }, 10_000);

  // Review Focus 4: nothing hangs on "Thinking". Plan 21 audit, 2026-11-23: the line was "I couldn't reach my agent;
  // try again", which trying again can't fix; it says what to do instead.
  it("an agent that isn't signed in gives one plain line", async () => {
    signedIn = false;
    const none = { reply: "No agent is signed in. Sign in to Fake", ionLine: "no-agent", threads: [] };
    expect(await turns().turn("chief", "hello")).toEqual(none);
    expect(await turns().turn("storefront", "hello")).toEqual(none);
  });

  it("a turn past its limit is stopped and says so", async () => {
    const started = Date.now();
    const r = await turns(100).turn("storefront", "take-your-time");
    expect(r).toEqual({ reply: TOO_LONG, ionLine: "late", threads: [], turnId: expect.any(String) });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("an agent slow to start counts against the limit too", async () => {
    process.env.ION_FAKE_START_MS = "3000";
    try {
      const started = Date.now();
      expect(await turns(100).turn("storefront", "hello")).toEqual({
        reply: TOO_LONG,
        ionLine: "late",
        threads: [],
        turnId: expect.any(String),
      });
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      delete process.env.ION_FAKE_START_MS;
    }
  });

  // The user, 2026-11-20: "can ions search the internet through their respective harness too" — "sure". An ion reads
  // a page its search found or one in your message; never one it made up (Task 7 ruling).
  it("an ion reads a page its search found or you gave it, and nothing it made up", async () => {
    const r = await turns().turn("chief", "try-web https://example.org/given");
    expect(r.reply).toBe(
      "Read https://nodejs.org/en/about/previous-releases. Read https://example.org/given. " +
        "Refused https://made.up/x: ion only reads pages it found or you gave it.",
    );
  });

  // Task 7 ruling, 2026-11-20: a report turn's prompt is an agent's words, not yours: no address in it may be read.
  it("a report turn reads no address from its prompt", async () => {
    const r = await turns().turn("chief", "try-web https://example.org/given", { noThreads: true });
    expect(r.reply).toContain(
      "Refused https://example.org/given: ion only reads pages it found or you gave it.",
    );
  });

  // Review Focus 2: the ion's agent tries to write; its gate denies it, and the turn goes on.
  it("an ion turn's edit is denied by its gate", async () => {
    const r = await turns().turn("storefront", "try-edit");
    expect(r.reply).toBe("I couldn't edit notes.md. This is storefront.");
    expect(existsSync(join(repo, "notes.md"))).toBe(false);
  });

  // Security review, 2026-11-19: a report turn's prompt holds an agent's words; it must not start work from them,
  // and no thread may be judged against words the daemon or an agent composed.
  it("a report turn starts no thread, even when its agent tries", async () => {
    const r = await turns().turn("chief", "please check storefront", { noThreads: true });
    expect(startThread).not.toHaveBeenCalled();
    expect(r.threads).toEqual([]);
    expect(r.reply).toBe("This is storefront.");
  });

  // Final review, 2026-11-19: a report turn's tools are told it's a report (no memory or profile writes there).
  it("a report turn's key says it's a report", async () => {
    const create = vi.spyOn(grants, "create");
    await turns().turn("storefront", "hello", { noThreads: true });
    await turns().turn("storefront", "hello");
    const scopes = create.mock.calls.map((c) => c[0]);
    expect(scopes.slice(0, 2).every((x) => x.kind === "ion" && x.report === true)).toBe(true);
    expect(scopes.slice(2).every((x) => x.kind === "ion" && !x.report)).toBe(true);
  });

  // Final review, 2026-11-19: ion chief kept its session when what it may see changed, so it still knew of a
  // project you'd kept from it or removed. It starts fresh when its shared projects change.
  it("ion chief starts a fresh session when its shared projects change", async () => {
    const t = turns();
    await t.turn("chief", "hello");
    const first = ionsView.session(db, "chief")!.nativeId;
    await t.turn("chief", "hello");
    expect(ionsView.session(db, "chief")!.nativeId).toBe(first);
    const cf = join(home, "config.toml");
    const { config } = loadUserConfig(cf);
    const projects = config.projects.map((p) => (p.id === "storefront" ? { ...p, shareWithIon: false } : p));
    saveUserConfig(cf, { ...config, projects });
    await t.turn("chief", "hello");
    // The fake agent keeps a resumed session's id: a new id is a fresh session.
    expect(ionsView.session(db, "chief")!.nativeId).not.toBe(first);
    expect(ionsView.session(db, "chief")!.projects).toEqual(["payments-api"]);
  });

  // Final review, 2026-11-19: a late turn whose session never closed kept it, so the next turn resumed a native
  // session still open in the agent: two sessions on one id. It's forgotten instead.
  it("a late turn whose session won't close forgets it", async () => {
    const t = turns(100);
    await t.turn("storefront", "hello");
    expect(ionsView.session(db, "storefront")).not.toBeNull();
    process.env.ION_FAKE_CLOSE_HANGS = "1";
    try {
      expect((await t.turn("storefront", "take-your-time")).reply).toBe(TOO_LONG);
      expect(ionsView.session(db, "storefront")).toBeNull();
    } finally {
      delete process.env.ION_FAKE_CLOSE_HANGS;
    }
  }, 15_000);

  // Plan 19's checks, 2026-11-22: a project with no agent of its own and no chats took the first ready agent; when
  // that one failed, its ion said only "I couldn't reach my agent" and ion's log said nothing. The failure is logged
  // once, and the turn goes on the next ready agent, which its reply names in one line.
  it("a turn whose agent fails goes on the next ready agent", async () => {
    const configFile = join(home, "config.toml");
    const c = loadUserConfig(configFile).config;
    // PR #36 re-review, 2026-11-23: a project's ion thinks with ion's brain; none picked, the strongest ready.
    const ion = { ...c.ion };
    delete ion.quick;
    saveUserConfig(configFile, { ...c, ion });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // opencode first (it ranks above the fake agent); it can't start here (real agents are off in tests).
      const r = await turns(undefined, { agents: both }).turn("storefront", "hello");
      expect(r.reply).toBe("This is storefront.\n\n*On Fake: opencode didn't answer.*");
      expect(log.mock.calls.map((x) => String(x[0]))).toEqual([
        "ion's agent (opencode): Error: real agents are off in tests",
      ]);
    } finally {
      log.mockRestore();
    }
  });

  // Security review, 2026-11-22: a retry on the next agent must not reset the turn's caps or repeat its work. Every
  // try is the same turn (one id), and a try that wrote memory (or started a thread) before failing isn't retried.
  describe("a turn that failed after its work", () => {
    let log: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      spoil.on = true;
      log = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      spoil.on = false;
      log.mockRestore();
    });

    it("isn't retried once it wrote memory", async () => {
      const r = await turns(undefined, { agents: both }).turn(
        "chief",
        "remind me to update the README on 2026-11-27",
      );
      expect(r.reply).toBe(NO_AGENT);
      expect(memory.paths()).toEqual(["you/update-the-readme.md"]);
      expect(log.mock.calls.map((x) => String(x[0]))).toEqual(["ion's agent (fake): it said nothing"]);
    });

    it("is retried as the same turn when it did nothing", async () => {
      const keys = vi.spyOn(grants, "create");
      const r = await turns(undefined, { agents: both }).turn("chief", "hello");
      expect(r.reply).toBe(NO_AGENT);
      expect(log.mock.calls.map((x) => String(x[0]))).toEqual([
        "ion's agent (fake): it said nothing",
        "ion's agent (opencode): Error: real agents are off in tests",
      ]);
      const ids = new Set(keys.mock.calls.map(([scope]) => (scope as { turnId: string }).turnId));
      expect(keys.mock.calls.length).toBeGreaterThan(2);
      expect([...ids]).toEqual([r.turnId]);
    });
  });

  // Task review, 2026-11-19: closing ion left an ion's turn running; its late writes hit a closed store.
  it("shutdown ends a running turn, and nothing is written after", async () => {
    const t = turns();
    const going = t.turn("storefront", "take-your-time");
    await vi.waitFor(() => expect(onIon("storefront").some((e) => e.type === EV.toolStarted)).toBe(true));
    const started = Date.now();
    await t.shutdown();
    const append = vi.spyOn(store, "append");
    const r = await going;
    expect(r.threads).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(append).not.toHaveBeenCalled();
    // A turn asked for after shutdown starts nothing.
    expect((await t.turn("storefront", "hello")).reply).toBe(NO_AGENT);
    expect(append).not.toHaveBeenCalled();
  }, 10_000);

  it("a turn's keys stop working when it ends", async () => {
    const create = vi.spyOn(grants, "create");
    await turns().turn("storefront", "hello");
    const keys = create.mock.results.map((x) => x.value as string);
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(grants.check(key)).toBeNull();
      expect(grants.check(key, "gate")).toBeNull();
    }
  });

  // The user, 2026-11-19: "there is no stop (double esc) for both plain chat and ions". Esc twice stops an ion's turn:
  // it says it stopped, and its next turn (a queued message) goes on.
  it("stop ends the ion's turn as stopped, and the next turn goes on", async () => {
    const t = turns();
    const going = t.turn("storefront", "take-your-time");
    const next = t.turn("storefront", "hello");
    await vi.waitFor(() => expect(onIon("storefront").some((e) => e.type === EV.toolStarted)).toBe(true));
    expect(t.busy("storefront")).toBe(true);
    expect(t.busy("chief")).toBe(false);
    const started = Date.now();
    expect(t.stop("storefront")).toBe(true);
    expect((await going).reply).toBe(STOPPED);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await next).reply).toBe("This is storefront.");
    expect(t.busy("storefront")).toBe(false);
    // Nothing to stop: nothing happens.
    expect(t.stop("storefront")).toBe(false);
  }, 10_000);

  // Final review, 2026-11-19: Esc twice (or Send now) while an ion reported on a thread cut the report, and the
  // thread's line said "Stopped." Stop ends only a turn answering your message; a report goes on.
  it("stop leaves a report turn alone", async () => {
    const t = turns();
    const report = t.turn("storefront", "take-your-time", { noThreads: true });
    await vi.waitFor(() => expect(onIon("storefront").some((e) => e.type === EV.toolStarted)).toBe(true));
    expect(t.stop("storefront")).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.busy("storefront")).toBe(true);
    await t.shutdown();
    expect((await report).reply).not.toBe(STOPPED);
  }, 10_000);

  // Final review, 2026-11-19: the same while the report is still starting.
  it("stop leaves a report turn alone while it starts", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    current = new IonTurns({
      ...{ store, db, configFile: join(home, "config.toml"), dataDir: join(home, "data") },
      ...{ grants, startThread, home },
      agents: async () => {
        await gate;
        return agents();
      },
      mcpUrl: () => `${base}/mcp`,
      gateUrl: () => `${base}/gate`,
    });
    made.push(current);
    const report = current.turn("storefront", "hello", { noThreads: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(current.stop("storefront")).toBe(false);
    release();
    expect((await report).reply).toBe("This is storefront.");
  }, 10_000);

  // Task review, 2026-11-19: Esc twice while an ion's turn was still finding its agent did nothing (and said ok).
  it("stop before the session starts ends that turn as stopped, and not the one behind it", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const slowAgents = async () => {
      if (first) {
        first = false;
        await gate;
      }
      return agents();
    };
    current = new IonTurns({
      ...{ store, db, configFile: join(home, "config.toml"), dataDir: join(home, "data") },
      ...{ grants, agents: slowAgents, startThread, home },
      mcpUrl: () => `${base}/mcp`,
      gateUrl: () => `${base}/gate`,
    });
    made.push(current);
    const t = current;
    const going = t.turn("storefront", "hello");
    const next = t.turn("storefront", "hello");
    await new Promise((r) => setTimeout(r, 20));
    expect(t.stop("storefront")).toBe(true);
    release();
    expect((await going).reply).toBe(STOPPED);
    expect((await next).reply).toBe("This is storefront.");
    expect(onIon("storefront").filter((e) => e.type === EV.toolStarted)).toHaveLength(1);
  }, 10_000);
});

// Final review, 2026-11-21: an ion's gate kept its own copy of ion's folders and missed ~/.cache/ion (where ion keeps
// each agent's config); it uses the same list as the runs' hard rules.
describe("what an ion may read", () => {
  it("never ion's own folders, ~/.cache/ion included", () => {
    const r = ionRules({ dataDir: "/d/data", configFile: "/c/ion/config.toml", home: "/Users/me" }, "/p");
    const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ion");
    expect(r.ionDirs).toEqual(expect.arrayContaining(["/d/data", "/c/ion", cache]));
    expect(r.home).toBe("/Users/me");
  });
});
