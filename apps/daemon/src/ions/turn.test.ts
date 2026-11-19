import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { EV, type HarnessInfo, type IonEvent } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateHandler } from "../gate/index.js";
import { createGrants, createMcpHandler } from "../mcp/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { ionsView } from "../views/ions.js";
import { ionInstructions } from "./instructions.js";
import { IonTurns, NO_AGENT, TOO_LONG } from "./turn.js";

process.env.ION_ALLOW_FAKE = "1";

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

const agents = async (): Promise<HarnessInfo[]> => [
  { id: "fake", label: "Fake", installed: true, signedIn, models: [], defaultModel: "fake" },
];

function turns(turnMs?: number): IonTurns {
  current = new IonTurns({
    ...{ store, db, configFile: join(home, "config.toml"), dataDir: join(home, "data") },
    grants,
    mcpUrl: () => `${base}/mcp`,
    gateUrl: () => `${base}/gate`,
    agents,
    startThread,
    home,
    ...(turnMs ? { turnMs } : {}),
  });
  return current;
}

let grants: ReturnType<typeof createGrants>;

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
  const mcp = createMcpHandler({
    ...{ store, db, grants, configFile },
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

afterEach(async () => {
  http.closeAllConnections();
  await new Promise((r) => http.close(r));
});

const onIon = (ionId: string) => store.read({ chatId: `ion:${ionId}` });

describe("an ion's turn", () => {
  it("a turn's last message is the reply, and the threads it started come with it", async () => {
    const text = "please check storefront and payments-api";
    const r = await turns().turn("chief", text);
    expect(r).toEqual({
      reply: "Asked 2 projects.",
      threads: [
        { chatId: "t-storefront", projectId: "storefront" },
        { chatId: "t-payments-api", projectId: "payments-api" },
      ],
    });
    // The judge reads your own words as the request, never the brief the ion's agent wrote.
    expect(startThread).toHaveBeenCalledWith("storefront", text, {
      ionId: "chief",
      request: text,
      turnId: expect.stringMatching(/^turn_/),
    });
    // Its work is kept on its chat under the turn's id, for the app to draw.
    const work = onIon("chief").filter((e: IonEvent) => e.type === EV.toolStarted);
    expect(work.map((e) => (e.data as { name: string }).name)).toEqual([
      "mcp__ion__projects",
      "mcp__ion__start_thread",
      "mcp__ion__start_thread",
    ]);
    expect(new Set(work.map((e) => e.runId)).size).toBe(1);
    expect(work[0]!.runId).toMatch(/^turn_/);
  });

  // Task review, 2026-11-19: run as the second project, so a scope mix-up (all projects) would answer "storefront".
  it("a project's ion sees only its project", async () => {
    const r = await turns().turn("payments-api", "what is this");
    expect(r).toEqual({ reply: "This is payments-api.", threads: [] });
  });

  it("ion chief can't start a thread in a project kept from it", async () => {
    const r = await turns().turn("chief", "please check private");
    expect(startThread).not.toHaveBeenCalled();
    expect(r.threads).toEqual([]);
  });

  // Task review, 2026-11-19: `default` pools chats without a project; it has no ion and gets no threads.
  it("ion chief can't start a thread in default", async () => {
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
    try {
      expect((await t.turn("storefront", "hello")).reply).toBe(NO_AGENT);
      expect(ionsView.session(db, "storefront")).toBeNull();
      // Fresh: a resumed session would fail again under this switch.
      expect((await t.turn("storefront", "hello")).reply).toBe("This is storefront.");
      expect(ionsView.session(db, "storefront")!.nativeId).not.toBe(first);
    } finally {
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

  it("a turn is told it's an ion", () => {
    expect(ionInstructions("chief")).toMatch(/^You are ion,/);
    expect(ionInstructions("storefront")).toMatch(/^You are ion for the project "storefront"/);
    expect(ionInstructions("chief")).toContain("&&");
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

  // Review Focus 4: nothing hangs on "Thinking".
  it("an agent that isn't signed in gives one plain line", async () => {
    signedIn = false;
    expect(await turns().turn("chief", "hello")).toEqual({ reply: NO_AGENT, threads: [] });
    expect(await turns().turn("storefront", "hello")).toEqual({ reply: NO_AGENT, threads: [] });
  });

  it("a turn past its limit is stopped and says so", async () => {
    const started = Date.now();
    const r = await turns(100).turn("storefront", "take-your-time");
    expect(r).toEqual({ reply: TOO_LONG, threads: [] });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("an agent slow to start counts against the limit too", async () => {
    process.env.ION_FAKE_START_MS = "3000";
    try {
      const started = Date.now();
      expect(await turns(100).turn("storefront", "hello")).toEqual({ reply: TOO_LONG, threads: [] });
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      delete process.env.ION_FAKE_START_MS;
    }
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
});
