import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxKind } from "@ion/adapter-kit";
import { describe, expect, it } from "vitest";
import { hookEnv, runHook, stopHooks, TAIL } from "./hooks.js";

// The user, 2026-11-20: "it should be hooks, showing all available events regardless if we have hooks, and of
// course, auto-approval hook should be listed as built-in, so it cannot be removed". A hook is a command run with
// /bin/sh -c, the event on stdin, a time limit, and the end of its output kept.

const dir = () => realpathSync(mkdtempSync(join(tmpdir(), "ion-hook-")));
const base = { stdin: "{}", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, limitMs: 5000 };

describe("running a hook", () => {
  it("runs with /bin/sh -c in its folder, with the event on stdin", async () => {
    const cwd = dir();
    const r = await runHook({ ...base, cwd, stdin: '{"type":"run.finished"}', run: 'pwd; cat; echo "$0"' });
    expect(r.code).toBe(0);
    expect(r.tail).toBe(`${cwd}\n{"type":"run.finished"}/bin/sh\n`);
  });

  it("stops at its time limit, keeps the last 2,000 chars, and keeps stderr apart", async () => {
    const started = Date.now();
    const r = await runHook({
      ...base,
      cwd: dir(),
      limitMs: 300,
      run: "i=0; while [ $i -lt 400 ]; do echo line-$i; i=$((i+1)); done; echo nope >&2; sleep 30",
    });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r).toMatchObject({ code: null, timedOut: true });
    expect(TAIL).toBe(2000);
    expect(r.tail.length).toBeLessThanOrEqual(2000);
    expect(r.tail.endsWith("nope\n")).toBe(true);
    expect(r.stderr).toBe("nope\n");
  });

  it("stops what the hook started too (its whole group)", async () => {
    const r = await runHook({ ...base, cwd: dir(), limitMs: 300, run: "(sleep 30; echo late) & wait" });
    expect(r.timedOut).toBe(true);
  });

  // Task review, 2026-11-21: what a hook left running in the background outlived it.
  it("what a hook started is stopped when it ends", async () => {
    const cwd = dir();
    const r = await runHook({ ...base, cwd, run: "(sleep 1; touch late) > /dev/null 2>&1 &" });
    expect(r.code).toBe(0);
    await new Promise((res) => setTimeout(res, 1500));
    expect(existsSync(join(cwd, "late"))).toBe(false);
  });

  // Task review, 2026-11-21: nothing stopped a running hook when ion stopped.
  it("a running hook can be stopped, with all it started", async () => {
    const cwd = dir();
    const live = new Set<number>();
    const p = runHook({ ...base, cwd, limitMs: 10_000, run: "(sleep 1; touch late) & sleep 5", live });
    await new Promise((res) => setTimeout(res, 200));
    expect(live.size).toBe(1);
    stopHooks(live);
    expect((await p).code).toBeNull();
    await new Promise((res) => setTimeout(res, 1300));
    expect(existsSync(join(cwd, "late"))).toBe(false);
  });

  it("says the exit code, and a hook that doesn't read stdin is fine", async () => {
    const r = await runHook({
      ...base,
      cwd: dir(),
      stdin: "x".repeat(1_000_000),
      run: "echo no >&2; exit 2",
    });
    expect(r).toMatchObject({ code: 2, stderr: "no\n", timedOut: false });
  });
});

// The user, 2026-11-20: anything that runs commands gets only what it needs — never ion's whole environment or a key.
describe("a hook's env", () => {
  it("holds only standard vars and ION_EVENT/PROJECT/EVENT_CHAT", () => {
    const env = hookEnv(
      { event: "run.finished", project: "app", chat: "c1" },
      { PATH: "/bin", HOME: "/Users/me", LANG: "C", GH_TOKEN: "secret-123456", ION_GATE_URL: "run-key-123" },
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/Users/me",
      LANG: "C",
      ION_EVENT: "run.finished",
      ION_PROJECT: "app",
      ION_EVENT_CHAT: "c1",
    });
  });

  // Final review, 2026-11-21: hooks got ION_CHAT, the marker of a chat's agent, and `ion` refuses inside a chat
  // without its run key, so your hooks couldn't run `ion` at all. The chat is ION_EVENT_CHAT; ION_HOME carries on.
  it("lets a hook run `ion status`", async () => {
    const cli = fileURLToPath(new URL("../../../cli/dist/index.js", import.meta.url));
    const home = dir();
    const env = hookEnv(
      { event: "run.finished", project: "app", chat: "c1" },
      { PATH: process.env.PATH, HOME: process.env.HOME, ION_HOME: home },
    );
    expect(env.ION_HOME).toBe(home);
    for (const cmd of ["status", "mcp ls"]) {
      const r = await runHook({ ...base, env, cwd: dir(), run: `"${process.execPath}" "${cli}" ${cmd}` });
      expect(r.tail.trim()).toBe("ion isn't running. Start it with: ion daemon start");
      expect(r.code).toBe(2);
    }
  });

  it("leaves out ION_PROJECT and ION_EVENT_CHAT when the event has none", () => {
    expect(hookEnv({ event: "briefing.posted" }, { PATH: "/bin" })).toEqual({
      PATH: "/bin",
      ION_EVENT: "briefing.posted",
    });
  });
});

// Automated review, 2026-11-21 (revised ruling): a hook can run code an agent wrote in the project, so hooks run in
// the sandbox: the project readable and writable, ion's folders not (ion stays reachable: hooks/reach.ts).
describe.skipIf(sandboxKind() !== "seatbelt")("a hook in the sandbox", () => {
  it("reads and writes the project, not ion's folders", async () => {
    const ion = dir();
    const project = dir();
    writeFileSync(join(ion, "daemon.json"), "full-token\n");
    writeFileSync(join(project, "README.md"), "project\n");
    const sandbox = {
      kind: "seatbelt" as const,
      paths: { deny: [ion], read: [], write: [], noWrite: [] },
      dataDir: ion,
    };
    const run = `cat README.md && echo built > out.txt && cat out.txt; cat ${ion}/daemon.json`;
    const r = await runHook({ ...base, cwd: project, sandbox, run });
    expect(r.tail).toContain("project\nbuilt\n");
    expect(r.tail).not.toContain("full-token");
  });
});
