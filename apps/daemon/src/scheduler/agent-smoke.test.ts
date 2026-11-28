import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, HarnessAdapter, Session, StartOpts } from "@ion/adapter-kit";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { EV, type HarnessInfo } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { createGrants, type IonScope } from "../mcp/index.js";
import { AgentSmoke, CHECK_ION } from "./agent-smoke.js";

// Plan 21 Task 5 (the user, 2026-11-28): the nightly check starts each agent for real, and the leak fix's lesson
// (2026-11-23: ~13 daemons left behind) holds: every process it starts is stopped, however its check ends.

type How = "answers" | "throws" | "hangs" | "fails-to-start";

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
  const smoke = new AgentSmoke({
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
  return { smoke, sessions: a.sessions, grants };
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
});
