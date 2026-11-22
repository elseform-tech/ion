import { EV, type NewEvent } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NeedsService } from "../needs/index.js";
import { Waits } from "../scheduler/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { clockOf, Handoffs } from "./limit-handoff.js";

const LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "grok-build": "Grok Build",
};

let db: Db;
let store: EventStore;
let needs: NeedsService;
let ready: string[];
let started: { chatId: string; harness: string; text: string; answers?: string }[];
let waits: Waits;
let handoffs: Handoffs;

const make = () =>
  new Handoffs({
    store,
    db,
    needs,
    ready: async () => ready,
    label: (h) => LABELS[h] ?? h,
    start: async (a, o) => {
      started.push({ ...a, ...(o.answers ? { answers: o.answers } : {}) });
      return `run_${started.length}`;
    },
    changed: async () => [{ path: "src/theme.ts", added: 12, removed: 3 }],
    waits,
  });

beforeEach(() => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  needs = new NeedsService(store, db);
  ready = ["claude-code", "codex", "grok-build"];
  started = [];
  waits = new Waits();
  handoffs = make();
});

afterEach(() => {
  waits.stop();
  vi.useRealTimers();
});

const add = (e: Omit<NewEvent, "origin"> & { origin?: "adapter" | "daemon" }) =>
  store.append({ origin: "daemon", ...e } as NewEvent);

/** A chat in project "repo" whose run on `harness` edited a file, said what's left, then hit the agent's limit. */
function hitLimit(
  chatId: string,
  harness: string,
  resetsAt?: string,
  o: { runId?: string; byIon?: boolean } = {},
) {
  const { runId = `run_${chatId}`, byIon = false } = o;
  if (!store.read({ chatId }).length)
    add({ chatId, runId: null, type: EV.chatCreated, data: { title: "Dark mode", projectId: "repo" } });
  const sent = byIon ? { text: "ion's brief", handoff: true } : { text: "Add a dark mode" };
  add({ chatId, runId, type: EV.messageSent, data: sent });
  add({ chatId, runId, type: EV.runQueued, data: {} });
  const a = { chatId, runId, origin: "adapter" as const };
  add({ ...a, type: EV.runStarted, data: { harness, model: "m", effort: null, authMethod: null } });
  add({
    ...a,
    type: EV.toolStarted,
    data: { toolId: "t1", name: "Edit", kind: "edit", summary: "src/theme.ts" },
  });
  add({ ...a, type: EV.toolFinished, data: { toolId: "t1", ok: true, summary: null } });
  add({ ...a, type: EV.messageCompleted, data: { text: "Left: wire the toggle in Settings." } });
  const limit = resetsAt ? { resetsAt } : {};
  const data = { code: "usage_limit", retryable: false, message: "Usage limit reached", limit };
  add({ ...a, type: EV.error, data });
  add({ chatId, runId, type: EV.runFinished, data: { status: "failed" } });
}

async function until<T>(f: () => T | undefined | false, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();
const clock = (iso: string) => clockOf(iso, new Date());
const lines = (chatId: string) =>
  store.read({ chatId, types: [EV.chatHandoff] }).map((e) => (e.data as { text: string }).text);

describe("Handoffs", () => {
  // The user, 2026-11-21: "figuring out a thread have reached rate limit and figuring a way to perform task handoff";
  // you decide by default: Continue / Wait / Always continue on <Other> here.
  it("a limit asks Continue or Wait", async () => {
    const resetsAt = inAnHour();
    hitLimit("c1", "claude-code", resetsAt);
    const n = await until(() => needs.open("c1")[0]);
    expect(n.summary).toBe(
      `Claude Code hit its limit (resets ${clock(resetsAt)}). Continue on Codex, or wait?`,
    );
    expect(n.choices?.map((c) => c.label)).toEqual([
      "Continue on Codex",
      "Wait",
      "Always continue on Codex here",
    ]);
    expect(started).toEqual([]);
  });

  // The user, 2026-11-21: Continue is a new run in the same worktree on the other agent, from a brief of the work.
  it("Continue starts the other agent in the same worktree with the brief", async () => {
    hitLimit("c1", "claude-code", inAnHour());
    const n = await until(() => needs.open("c1")[0]);
    await handoffs.answer(n.needId, 1, "chat");
    expect(started).toHaveLength(1);
    const s = started[0]!;
    // The same chat: its run goes in the chat's own worktree.
    expect([s.chatId, s.harness, s.answers]).toEqual(["c1", "codex", n.needId]);
    expect(s.text).toContain('"Add a dark mode"');
    expect(s.text).toContain("src/theme.ts (+12 −3)");
    expect(s.text).toContain("Edit: src/theme.ts");
    expect(s.text).toContain('"Usage limit reached"');
    expect(s.text).toContain('"Left: wire the toggle in Settings."');
    expect(s.text).toContain("Check git status and the tests before continuing");
    expect(lines("c1")).toEqual(["Continued on Codex — Claude Code hit its limit"]);
    expect(needs.open("c1")).toEqual([]);
  });

  // The user, 2026-11-21: "Always continue on <Other> here" is a decision for the project; next time ion continues
  // without asking, and says so.
  it("Always continues without asking next time", async () => {
    hitLimit("c1", "claude-code", inAnHour());
    const n = await until(() => needs.open("c1")[0]);
    await handoffs.answer(n.needId, 3, "chat");
    expect(started.map((s) => s.harness)).toEqual(["codex"]);
    hitLimit("c2", "claude-code", inAnHour());
    await until(() => started.length === 2);
    expect(started[1]).toMatchObject({ chatId: "c2", harness: "codex" });
    expect(needs.open("c2")).toEqual([]);
    expect(lines("c2")).toEqual(["Continued on Codex — Claude Code hit its limit · always here"]);
  });

  // The user, 2026-11-21 (Review Focus 5): only agents that aren't limited are offered; none left, Wait alone, with
  // the earliest reset.
  it("a limited target isn't offered", async () => {
    hitLimit("c0", "codex", inAnHour());
    await until(() => needs.open("c0")[0]);
    hitLimit("c1", "claude-code", inAnHour());
    const n = await until(() => needs.open("c1")[0]);
    expect(n.choices?.map((c) => c.label)).toEqual([
      "Continue on Grok Build",
      "Wait",
      "Always continue on Grok Build here",
    ]);
    const soon = new Date(Date.now() + 600_000).toISOString();
    hitLimit("c2", "grok-build", soon);
    const w = await until(() => needs.open("c2")[0]);
    expect(w.summary).toBe(`Grok Build hit its limit (resets ${clock(soon)}). No other agent is free.`);
    expect(w.choices?.map((c) => c.label)).toEqual(["Wait"]);
    expect(w.choices?.[0]?.consequence).toBe(`ion goes on at ${clock(soon)}.`);
  });

  // The user, 2026-11-21: Wait re-queues the chat for the reset time.
  it("Wait resumes at the reset", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const resetsAt = new Date(Date.now() + 120_000).toISOString();
    hitLimit("c1", "claude-code", resetsAt);
    const n = await vi.waitFor(() => {
      const open = needs.open("c1")[0];
      if (!open) throw new Error("not asked yet");
      return open;
    });
    await handoffs.answer(n.needId, 2, "chat");
    expect(lines("c1")).toEqual([`Waits for Claude Code — ${clock(resetsAt)}`]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toEqual([]);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(started.map((s) => [s.chatId, s.harness])).toEqual([["c1", "claude-code"]]);
    expect(started[0]!.text).toContain("Check git status and the tests before continuing");
  });

  // The user, 2026-11-21 (Review Focus 3): two threads on one limit: one mark, each thread asks once, no storm.
  it("two threads on one limit ask once each", async () => {
    const resetsAt = inAnHour();
    hitLimit("c1", "claude-code", resetsAt);
    hitLimit("c2", "claude-code", resetsAt);
    await until(() => needs.open().length === 2);
    // The same chat failing on the limit again while its question waits doesn't ask again.
    hitLimit("c1", "claude-code", resetsAt, { runId: "run_again" });
    await new Promise((r) => setTimeout(r, 30));
    expect(
      needs
        .open()
        .map((n) => n.chatId)
        .sort(),
    ).toEqual(["c1", "c2"]);
    expect(started).toEqual([]);
  });

  // The user, 2026-11-22: "better to verify than guessing". A limit that didn't say when it resets is only ion's
  // guess: that agent may be offered ("may be free again") and trying it tells, never assumed either way.
  it("an agent limited only by a guess is offered as may be free again", async () => {
    hitLimit("c0", "codex"); // no reset said: a guess
    await until(() => needs.open("c0")[0]);
    hitLimit("c9", "grok-build", inAnHour());
    await until(() => needs.open("c9")[0]);
    hitLimit("c1", "claude-code", inAnHour());
    const n = await until(() => needs.open("c1")[0]);
    expect(n.choices?.[0]?.label).toBe("Continue on Codex (may be free again)");
    await handoffs.answer(n.needId, 1, "chat");
    expect(started.map((s) => [s.chatId, s.harness])).toEqual([["c1", "codex"]]);
  });

  // The user, 2026-11-22: Wait without a known reset re-checks by trying, not by a fixed timer alone: still limited,
  // it waits again (a few times), without asking again.
  it("Wait without a known reset tries again, and waits again while still limited", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    hitLimit("c1", "claude-code");
    const n = await vi.waitFor(() => {
      const open = needs.open("c1")[0];
      if (!open) throw new Error("not asked yet");
      return open;
    });
    expect(n.summary).toBe("Claude Code hit its limit. Continue on Codex, or wait?");
    await handoffs.answer(n.needId, 2, "chat");
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1000);
    expect(started.map((s) => s.harness)).toEqual(["claude-code"]);
    hitLimit("c1", "claude-code", undefined, { runId: "run_try", byIon: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(needs.open("c1")).toEqual([]);
    expect(lines("c1").at(-1)).toMatch(/^Still at its limit — tries again at \d\d:\d\d$/);
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1000);
    expect(started.map((s) => s.harness)).toEqual(["claude-code", "claude-code"]);
  });

  // The user, 2026-11-21: Wait holds across a restart: ion waits again for the reset, never forgets the chat.
  it("a chat waiting for a reset still goes on after ion restarts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    hitLimit("c1", "claude-code", new Date(Date.now() + 120_000).toISOString());
    const n = await vi.waitFor(() => {
      const open = needs.open("c1")[0];
      if (!open) throw new Error("not asked yet");
      return open;
    });
    await handoffs.answer(n.needId, 2, "chat");
    handoffs.stop(); // ion stopped
    waits = new Waits();
    handoffs = make();
    await vi.advanceTimersByTimeAsync(121_000);
    expect(started.map((s) => [s.chatId, s.harness])).toEqual([["c1", "claude-code"]]);
  });

  // Live check, 2026-11-22: the question box's "Something else" goes to the agent offered, with ion's brief.
  it("your own words go to the agent offered, with the brief", async () => {
    hitLimit("c1", "claude-code", inAnHour());
    const n = await until(() => needs.open("c1")[0]);
    await handoffs.answer(n.needId, "Only finish the tests", "chat");
    expect(started.map((s) => [s.chatId, s.harness])).toEqual([["c1", "codex"]]);
    expect(started[0]!.text).toContain('The user adds: "Only finish the tests"');
    expect(started[0]!.text).toContain("Check git status and the tests before continuing");
    expect(needs.open("c1")).toEqual([]);
  });

  // Live check, 2026-11-22: opencode's wait (no reset said) came back after a restart, its try hit the limit again,
  // and ion asked again instead of trying again later: a restored wait forgot its reset was a guess.
  it("a restored wait without a known reset still waits again while limited", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    hitLimit("c1", "claude-code");
    const n = await vi.waitFor(() => {
      const open = needs.open("c1")[0];
      if (!open) throw new Error("not asked yet");
      return open;
    });
    await handoffs.answer(n.needId, 2, "chat");
    handoffs.stop(); // ion stopped
    waits = new Waits();
    handoffs = make();
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1000);
    expect(started.map((s) => s.harness)).toEqual(["claude-code"]);
    hitLimit("c1", "claude-code", undefined, { runId: "run_try", byIon: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(needs.open("c1")).toEqual([]);
    expect(lines("c1").at(-1)).toMatch(/^Still at its limit — tries again at \d\d:\d\d$/);
  });
});
