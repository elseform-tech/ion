import { mkdtempSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type HookEntry, saveUserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { createSigner } from "../secrets/consent-key.js";
import { memorySecrets } from "../secrets/index.js";
import { hookHasher } from "./consent.js";
import { Hooks, LIMITS } from "./index.js";

// The user, 2026-11-20: "it should be hooks, showing all available events regardless if we have hooks, and of
// course, auto-approval hook should be listed as built-in, so it cannot be removed". Your hooks run on ion's events;
// "Before a tool runs" hooks may refuse a call, ahead of Auto-approval.

let db: Db;
let store: EventStore;
let home: string;
let proj: string;
let configFile: string;
let hooks: Hooks;
let stop: () => void;

const fast = { eventMs: 3000, beforeMs: 400, budgetMs: 5000, perRun: 4 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sign = createSigner(memorySecrets());

async function save(list: (Omit<HookEntry, "on"> & { on?: boolean })[], consent = true) {
  const all = list.map((h) => ({ on: true, ...h })) as HookEntry[];
  const hash = await hookHasher(sign, all);
  saveUserConfig(configFile, {
    ...DEFAULT_CONFIG,
    projects: [
      { id: "app", path: proj, name: "Storefront", starred: false },
      { id: "other", path: home, starred: false },
    ],
    tools: {
      ...DEFAULT_CONFIG.tools,
      hooks: all,
      hooksOn: consent ? all.map((h) => `${h.id}@${hash(h)}`) : [],
    },
  });
}

let n = 0;
function chat(projectId = "app", title = "Fix the cart"): string {
  const chatId = `c${++n}`;
  store.append({ chatId, runId: null, origin: "daemon", type: EV.chatCreated, data: { title, projectId } });
  return chatId;
}

const finish = (chatId: string, status = "done") =>
  store.append({ chatId, runId: `r-${chatId}`, origin: "adapter", type: EV.runFinished, data: { status } });

const ran = () => store.read({ chatId: "hooks", types: [EV.hookRan] }).map((e) => e.data);
const notes = () => store.read({ chatId: "notify", types: [EV.notify] }).map((e) => e.data);

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "ion-hooks-")));
  proj = realpathSync(mkdtempSync(join(tmpdir(), "ion-proj-")));
  configFile = join(home, "config.toml");
  db = openDb(join(home, "ion.db"));
  store = new EventStore(db, allViews);
  hooks = new Hooks({ store, db, configFile, sign, limits: fast });
  stop = hooks.start();
});

afterEach(() => {
  stop();
  db.close();
});

describe("hooks on ion's events", () => {
  it("has the limits the plan sets: 60 s, and 10 s before a tool runs", () => {
    // Task review, 2026-11-21: a 15 s budget for one call across all its hooks, at most 4 hook processes per run.
    expect(LIMITS).toEqual({ eventMs: 60_000, beforeMs: 10_000, budgetMs: 15_000, perRun: 4 });
  });

  it("runs on a matching event with the event on stdin, ION_* env, in the project's folder", async () => {
    const out = join(home, "out.txt");
    await save([
      {
        id: "h1",
        name: "Log",
        event: "run.finished",
        run: `{ cat; echo; echo "$ION_EVENT|$ION_PROJECT|$ION_EVENT_CHAT|$(pwd)"; } > ${out}`,
      },
    ]);
    const c = chat();
    finish(c);
    await hooks.idle();
    const [json, line] = readFileSync(out, "utf8").trim().split("\n");
    const sent = JSON.parse(json!);
    expect(sent).toMatchObject({
      type: "run.finished",
      chatId: c,
      data: { status: "done" },
      project: "Storefront",
      chat: "Fix the cart",
    });
    expect(line).toBe(`run.finished|app|${c}|${proj}`);
    expect(ran()).toEqual([{ hookId: "h1", ok: true, code: 0, ms: expect.any(Number), tail: "" }]);
    expect(hooks.last("h1")).toMatchObject({ ok: true, code: 0, tail: "" });
  });

  it("a failed run is A chat fails, not A chat finishes; another project's hook doesn't run", async () => {
    const out = join(home, "out.txt");
    await save([
      { id: "done", name: "Done", event: "run.finished", run: `echo done >> ${out}` },
      { id: "fail", name: "Fail", event: "run.failed", run: `echo failed >> ${out}` },
      { id: "elsewhere", name: "X", event: "run.failed", run: `echo other >> ${out}`, project: "other" },
    ]);
    finish(chat(), "failed");
    await hooks.idle();
    expect(readFileSync(out, "utf8")).toBe("failed\n");
  });

  it("a hand-edited hook starts off until turned on", async () => {
    const out = join(home, "out.txt");
    await save([{ id: "h1", name: "Log", event: "run.finished", run: `echo hi > ${out}` }], false);
    finish(chat());
    await hooks.idle();
    expect(existsSync(out)).toBe(false);
    expect(ran()).toEqual([]);
  });

  it("one at a time per hook: one more waits, the rest are dropped", async () => {
    const out = join(home, "out.txt");
    await save([{ id: "h1", name: "Slow", event: "run.finished", run: `sleep 0.3; echo x >> ${out}` }]);
    const c = chat();
    for (let i = 0; i < 4; i++) finish(c);
    await hooks.idle();
    expect(readFileSync(out, "utf8")).toBe("x\nx\n");
  });

  it("a failing hook is reported once, not per event", async () => {
    await save([{ id: "h1", name: "Broken", event: "run.finished", run: "echo oops; exit 1" }]);
    const c = chat();
    for (let i = 0; i < 3; i++) {
      finish(c);
      await hooks.idle();
    }
    expect(ran().map((d) => [d.ok, d.code, d.tail])).toEqual([
      [false, 1, "oops\n"],
      [false, 1, "oops\n"],
      [false, 1, "oops\n"],
    ]);
    expect(notes()).toEqual([{ title: "ion", body: "The hook “Broken” failed", kind: "needs" }]);
  });

  // Task review, 2026-11-21: nothing stopped a running hook when ion stopped.
  it("a running hook is stopped when ion stops", async () => {
    const out = join(home, "late.txt");
    await save([{ id: "h1", name: "Slow", event: "run.finished", run: `sleep 1; touch ${out}` }]);
    finish(chat());
    await wait(200);
    hooks.stop();
    await wait(1300);
    expect(existsSync(out)).toBe(false);
    // Stopped: it hears nothing more.
    finish(chat());
    await wait(1300);
    expect(existsSync(out)).toBe(false);
  });

  // Task review, 2026-11-21: a run ion's own restart ended was told to your hooks as a failed chat.
  it("a run ion's own restart ended isn't A chat fails", async () => {
    const out = join(home, "out.txt");
    await save([{ id: "f", name: "Fail", event: "run.failed", run: `echo failed >> ${out}` }]);
    const c = chat();
    const err = { code: "daemon_restarted", retryable: false, message: "ion restarted" };
    store.append({ chatId: c, runId: `r-${c}`, origin: "daemon", type: EV.error, data: err });
    finish(c, "failed");
    await hooks.idle();
    expect(existsSync(out)).toBe(false);
  });

  // Task review, 2026-11-21: the once-a-day check went by the hook's name, so two hooks with one name shared it.
  it("the once-a-day report goes by the hook, not its name, also across a restart", async () => {
    await save([
      { id: "a", name: "Check", event: "run.finished", run: "exit 1" },
      { id: "b", name: "Check", event: "run.finished", run: "exit 1" },
    ]);
    finish(chat());
    await hooks.idle();
    expect(notes()).toHaveLength(2);
    stop();
    const again = new Hooks({ store, db, configFile, sign, limits: fast });
    stop = again.start();
    finish(chat());
    await again.idle();
    expect(notes()).toHaveLength(2);
  });

  it("keeps a key out of what it keeps of the output", async () => {
    await save([
      { id: "h1", name: "Leaky", event: "run.finished", run: "echo token=ghp_A1b2C3d4E5f6G7h8I9j0K1l2" },
    ]);
    finish(chat());
    await hooks.idle();
    expect(JSON.stringify(ran())).not.toContain("ghp_A1b2C3d4E5f6G7h8I9j0K1l2");
  });
});

const call = (command: string) => ({
  toolName: "Bash",
  kind: "command" as const,
  summary: command,
  input: { command },
});
const runOf = (chatId: string, projectId = "app") => ({ chatId, runId: `r-${chatId}`, projectId });
const RM_GUARD = `case "$(cat)" in *'"rm '*) printf 'No rm\\a here' >&2; exit 2;; esac`;

describe("hooks before a tool runs", () => {
  it("a Before a tool runs hook that exits 2 refuses the call with its message", async () => {
    await save([{ id: "g", name: "No rm", event: "tool.before", run: RM_GUARD }]);
    const c = chat();
    expect(await hooks.beforeTool(runOf(c), call("rm -rf build"))).toEqual({ reason: "No rm here" });
    expect(await hooks.beforeTool(runOf(c), call("ls"))).toBeNull();
    // A refusal is the hook doing its job: not reported.
    expect(notes()).toEqual([]);
  });

  it("sends the call, the project and the chat on stdin", async () => {
    const out = join(home, "seen.json");
    await save([{ id: "g", name: "Log", event: "tool.before", run: `cat > ${out}` }]);
    const c = chat();
    await hooks.beforeTool(runOf(c), call("ls"));
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      type: "tool.before",
      chatId: c,
      data: { tool: "Bash", kind: "command", summary: "ls", input: { command: "ls" } },
      project: "Storefront",
      chat: "Fix the cart",
    });
  });

  it("runs in order and stops at the first that refuses; only the run's project's hooks", async () => {
    const out = join(home, "out.txt");
    await save([
      { id: "a", name: "A", event: "tool.before", run: `echo a >> ${out}` },
      { id: "b", name: "B", event: "tool.before", run: `echo b >> ${out}; echo stop >&2; exit 2` },
      { id: "c", name: "C", event: "tool.before", run: `echo c >> ${out}` },
      { id: "d", name: "D", event: "tool.before", run: `echo d >> ${out}`, project: "other" },
    ]);
    expect(await hooks.beforeTool(runOf(chat()), call("ls"))).toEqual({ reason: "stop" });
    expect(readFileSync(out, "utf8")).toBe("a\nb\n");
  });

  it("one that hangs lets the call go on after its limit and is reported once", async () => {
    await save([{ id: "g", name: "Stuck", event: "tool.before", run: "sleep 30" }]);
    const c = chat();
    const started = Date.now();
    // The call goes on; Auto-approval is told a check didn't finish (Task review, 2026-11-21).
    // A fixed note, never the hook's name (Task review, 2026-11-21: names are config text).
    const failed = { failed: true };
    expect(await hooks.beforeTool(runOf(c), call("ls"))).toEqual(failed);
    expect(Date.now() - started).toBeLessThan(fast.beforeMs + 2000);
    expect(await hooks.beforeTool(runOf(c), call("pwd"))).toEqual(failed);
    expect(ran().map((d) => [d.ok, d.code])).toEqual([
      [false, null],
      [false, null],
    ]);
    expect(notes()).toEqual([{ title: "ion", body: "The hook “Stuck” took too long", kind: "needs" }]);
  });

  // Task review, 2026-11-21: three slow hooks held one call for 30 s; now 15 s in all, then Auto-approval decides.
  it("one call's hooks share one time budget; the rest are skipped after it", async () => {
    hooks.stop();
    hooks = new Hooks({ store, db, configFile, sign, limits: { ...fast, budgetMs: 600 } });
    stop = hooks.start();
    await save([
      { id: "a", name: "A", event: "tool.before", run: "sleep 2" },
      { id: "b", name: "B", event: "tool.before", run: "sleep 2" },
      { id: "c", name: "C", event: "tool.before", run: "sleep 2" },
    ]);
    const started = Date.now();
    const r = await hooks.beforeTool(runOf(chat()), call("ls"));
    expect(r).toEqual({ failed: true });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(ran().map((d) => d.hookId)).toEqual(["a", "b"]);
  });

  // Task review, 2026-11-21: a guard hook whose consent couldn't be checked (a locked keychain) was skipped silently.
  it("a guard hook that can't be checked lets the call go on, and Auto-approval is told", async () => {
    await save([{ id: "g", name: "No rm", event: "tool.before", run: "exit 2" }]);
    hooks.stop();
    const locked = () => Promise.reject(new Error("Your keychain is locked"));
    hooks = new Hooks({ store, db, configFile, sign: locked, limits: fast });
    stop = hooks.start();
    expect(await hooks.beforeTool(runOf(chat()), call("rm x"))).toEqual({ failed: true });
    expect(ran()).toEqual([]);
  });

  // Task review, 2026-11-21: a call asked while ion stops (hooks already stopped) must not pass its guards silently.
  it("a call asked after hooks stopped goes on with Auto-approval told", async () => {
    await save([{ id: "g", name: "No rm", event: "tool.before", run: "exit 2" }]);
    hooks.stop();
    expect(await hooks.beforeTool(runOf(chat()), call("rm x"))).toEqual({ failed: true });
  });

  // Task review, 2026-11-21: waiting for a free slot didn't count against the call's budget.
  it("the wait for a slot counts against the call's budget", async () => {
    hooks.stop();
    hooks = new Hooks({ store, db, configFile, sign, limits: { ...fast, budgetMs: 300, perRun: 1 } });
    stop = hooks.start();
    await save([{ id: "g", name: "Slow", event: "tool.before", run: "sleep 2" }]);
    const run = runOf(chat());
    const started = Date.now();
    const both = await Promise.all([hooks.beforeTool(run, call("ls")), hooks.beforeTool(run, call("pwd"))]);
    expect(both).toEqual([{ failed: true }, { failed: true }]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ran()).toHaveLength(1);
  });

  it("at most 4 hook processes at once for one run; the others wait", async () => {
    const out = join(home, "out.txt");
    await save([
      { id: "g", name: "Log", event: "tool.before", run: `echo + >> ${out}; sleep 0.3; echo - >> ${out}` },
    ]);
    const run = runOf(chat());
    await Promise.all(Array.from({ length: 6 }, () => hooks.beforeTool(run, call("ls"))));
    let now = 0;
    let most = 0;
    for (const l of readFileSync(out, "utf8").trim().split("\n")) {
      now += l === "+" ? 1 : -1;
      most = Math.max(most, now);
    }
    expect(most).toBe(4);
    expect(ran()).toHaveLength(6);
  });

  it("a long refusal is cut to 300 characters", async () => {
    await save([{ id: "g", name: "Wordy", event: "tool.before", run: "printf '%0400d' 0 >&2; exit 2" }]);
    const r = await hooks.beforeTool(runOf(chat()), call("ls"));
    expect(r?.reason).toBe("0".repeat(300));
  });
});
