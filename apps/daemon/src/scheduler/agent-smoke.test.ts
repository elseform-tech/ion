import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, HarnessAdapter, Session, StartOpts } from "@ion/adapter-kit";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { EV, type HarnessInfo } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { createGrants, type IonScope } from "../mcp/index.js";
import { limitedUntil } from "../ions/brain.js";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { recordTo } from "../views/usage.js";
import { AgentSmoke, CHECK_ION } from "./agent-smoke.js";

// Plan 21 Task 5 (the user, 2026-11-28): the nightly check starts each agent for real, and the leak fix's lesson
// (2026-11-23: ~13 daemons left behind) holds: every process it starts is stopped, however its check ends.

type How = "answers" | "throws" | "hangs" | "fails-to-start" | "used-up";

const signedIn: HarnessInfo = {
  id: "fake",
  label: "Fake",
  installed: true,
  signedIn: true,
  models: [],
  defaultModel: null,
};

/** A fake agent: what it does with the prompt, and whether each session it started was closed. */
function agent(how: How, grants: ReturnType<typeof createGrants>) {
  const sessions: { closed: boolean; opts: StartOpts }[] = [];
  const adapter = {
    id: "fake",
    gateCall: (p: unknown) => p as never,
    start: async (opts: StartOpts): Promise<Session> => {
      if (how === "fails-to-start") throw new Error("no such binary");
      const s = { closed: false, opts };
      sessions.push(s);
      let sent = "";
      return {
        id: "s1",
        nativeId: null,
        send: async ({ text }) => {
          sent = text;
        },
        interrupt: async () => {},
        close: async () => {
          s.closed = true;
        },
        events: async function* (): AsyncGenerator<AdapterEvent> {
          if (how === "hangs") {
            await new Promise((r) => setTimeout(r, 60_000));
            return;
          }
          if (how === "throws") throw new Error("broken pipe");
          if (how === "used-up") {
            yield {
              type: EV.error,
              data: {
                code: "usage_limit",
                retryable: false,
                message: "opencode's free usage is used up",
                limit: {},
              },
            } as AdapterEvent;
            yield { type: EV.runFinished, data: { status: "failed" } } as AdapterEvent;
            return;
          }
          // What a real agent does: ion's tool for its word, a file read through the gate, then the two words.
          const key = opts.mcpServers![0]!.headers.Authorization!.slice("Bearer ".length);
          const scope = grants.check(key) as IonScope;
          const word = scope.check!.word;
          const gateKey = opts.gate!.url.split("/").at(-1)!;
          const gateScope = grants.check(gateKey, "gate") as IonScope;
          const read = {
            toolName: "Read",
            kind: "read",
            summary: "word.txt",
            input: { path: join(opts.cwd, "word.txt") },
          };
          expect(smokeOf.current!.gate(gateScope, read)).toMatchObject({ decision: "allow" });
          const file = readFileSync(join(opts.cwd, "word.txt"), "utf8").trim();
          expect(sent).toContain("word.txt");
          yield { type: EV.messageCompleted, data: { text: `${word} ${file}` } } as AdapterEvent;
          yield { type: EV.runFinished, data: { status: "done" } } as AdapterEvent;
        },
      };
    },
  } as unknown as HarnessAdapter;
  return { adapter, sessions };
}

const smokeOf: { current?: AgentSmoke } = {};

function setup(how: How, who: HarnessInfo = signedIn) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "ion-agent-smoke-")));
  const configFile = join(dataDir, "config.toml");
  saveUserConfig(configFile, DEFAULT_CONFIG);
  const grants = createGrants();
  const a = agent(how, grants);
  const heard: { harness: string; type: string; data: unknown }[] = [];
  const smoke = new AgentSmoke({
    record: (harness, e) => heard.push({ harness, type: e.type, data: e.data }),
    dataDir,
    configFile,
    grants,
    mcpUrl: () => "http://127.0.0.1:1/mcp",
    gateUrl: () => "http://127.0.0.1:1/gate",
    adapter: () => a.adapter,
    info: async () => who,
    own: async () => ({}),
    limitMs: 300,
  });
  smokeOf.current = smoke;
  return { smoke, sessions: a.sessions, grants, heard };
}

const names = (items: { name: string; ok: boolean }[]) =>
  Object.fromEntries(items.map((i) => [i.name, i.ok]));

describe("an agent's nightly check", () => {
  it("passes an agent that answers through ion's tools and its gate", async () => {
    const { smoke, sessions } = setup("answers");
    const items = await smoke.run("fake", null, new AbortController().signal);
    expect(names(items)).toEqual({
      "Signed in": true,
      Starts: true,
      Answers: true,
      "ion's tools": true,
      Gate: true,
    });
    expect(sessions[0]!.opts.mcpServers?.[0]?.name).toBe("ion");
  });

  it("every process it starts is stopped", async () => {
    for (const how of ["answers", "throws", "hangs"] as const) {
      const { smoke, sessions, grants } = setup(how);
      const items = await smoke.run("fake", null, new AbortController().signal);
      expect(sessions, how).toHaveLength(1);
      expect(sessions[0]!.closed, how).toBe(true);
      // Its keys stop working, and its folder goes.
      const key = sessions[0]!.opts.mcpServers![0]!.headers.Authorization!.slice("Bearer ".length);
      expect(grants.check(key), how).toBeNull();
      expect(existsSync(sessions[0]!.opts.cwd), how).toBe(false);
      if (how !== "answers") expect(names(items)["Answers"], how).toBe(false);
    }
  });

  it("stops at once when ion stops", async () => {
    const { smoke, sessions } = setup("hangs");
    const stop = new AbortController();
    const going = smoke.run("fake", null, stop.signal);
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    await going;
    expect(sessions[0]!.closed).toBe(true);
  });

  it("says an agent that won't start, or is signed out", async () => {
    const { smoke } = setup("fails-to-start");
    expect(names(await smoke.run("fake", null, new AbortController().signal))).toEqual({
      "Signed in": true,
      Starts: false,
    });
    const out = setup("answers", { ...signedIn, signedIn: false });
    expect(names(await out.smoke.run("fake", null, new AbortController().signal))).toEqual({
      "Signed in": false,
    });
  });

  it("its gate lets through only ion's check tool and reads in its folder", async () => {
    const { smoke } = setup("answers");
    const scope: IonScope = { kind: "ion", ionId: CHECK_ION, projects: [], turnId: "check_none" };
    // Live check, 2026-11-28: opencode's hook gives ion's check tool as `ion_check`, kind "other"; it was refused, so
    // ion's word never came back. By its name, any kind; nothing else of MCP.
    const live = smoke as unknown as {
      live: Map<string, unknown>;
      verdict: (t: unknown, r: object) => unknown;
    };
    const t = { adapter: {}, rules: { roots: [], home: "/nope", ionDirs: [] }, seen: 0 };
    const req = (toolName: string, kind: string) => ({
      requestId: "g",
      toolId: "g",
      toolName,
      kind,
      summary: "",
      input: {},
    });
    expect(live.verdict(t, req("ion_check", "other"))).toEqual({ decision: "allow" });
    expect(live.verdict(t, req("mcp__ion__check", "mcp"))).toEqual({ decision: "allow" });
    expect(live.verdict(t, req("mcp__ion__projects", "mcp"))).toEqual({ decision: "deny" });
    expect(live.verdict(t, req("bash", "command"))).toEqual({ decision: "deny" });
    // A call from no check going: ion can't read it.
    expect(smoke.gate(scope, { toolName: "Read", kind: "read", summary: "", input: {} })).toBeNull();
  });

  // Task 5 review, 2026-11-28 (live: opencode's free use ran out): used up isn't broken. Answers says so and passes,
  // ion's tools and the gate aren't counted against it, and the limit goes in its agent's usage (its mark).
  it("says an agent whose use is used up, and records its limit", async () => {
    const { smoke, sessions, heard } = setup("used-up");
    const items = await smoke.run("fake", null, new AbortController().signal);
    expect(items).toEqual([
      { name: "Signed in", ok: true },
      { name: "Starts", ok: true },
      { name: "Answers", ok: true, limited: true, note: "Its free use is used up" },
    ]);
    expect(heard).toContainEqual(expect.objectContaining({ harness: "fake", type: EV.error }));
    expect(sessions[0]!.closed).toBe(true);
    // What it heard, kept as ion keeps it (recordTo): the agent's limit mark is set.
    const db = openDb(":memory:");
    const store = new EventStore(db, allViews);
    for (const h of heard)
      recordTo(store)(h.harness, { type: h.type, data: h.data } as AdapterEvent, new Date().toISOString());
    expect(limitedUntil(db, "fake")).not.toBeNull();
  });

  it("lets ion's check tool through only from ion's server, when the agent names one", () => {
    const { smoke } = setup("answers");
    const t = { adapter: {}, rules: { roots: [], home: "/nope", ionDirs: [] }, seen: 0 };
    const v = (smoke as unknown as { verdict: (t: unknown, r: object) => unknown }).verdict.bind(smoke);
    const req = (mcpServer?: string) => ({
      ...{ requestId: "g", toolId: "g", toolName: "mcp__ion__check", kind: "mcp", summary: "", input: {} },
      ...(mcpServer ? { mcpServer } : {}),
    });
    expect(v(t, req("ion"))).toEqual({ decision: "allow" });
    expect(v(t, req())).toEqual({ decision: "allow" });
    expect(v(t, req("evil"))).toEqual({ decision: "deny" });
  });
});
