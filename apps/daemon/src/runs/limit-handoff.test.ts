import { EV, type NewEvent } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NeedsService } from "../needs/index.js";
import { Waits } from "../scheduler/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { decisionsView } from "../views/decisions.js";
import { allViews } from "../views/index.js";
import { messagesView } from "../views/messages.js";
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
let started: { chatId: string; harness: string; text: string; answers?: string; access?: string }[];
let waits: Waits;
let handoffs: Handoffs;

const depsOf = () => ({
  store,
  db,
  needs,
  ready: async () => ready,
  label: (h) => LABELS[h] ?? h,
  start: async (
    a: { chatId: string; harness: string; text: string; access?: string },
    o: { answers?: string },
  ) => {
    started.push({ ...a, ...(o.answers ? { answers: o.answers } : {}) });
    return `run_${started.length}`;
  },
  changed: async () => [{ path: "src/theme.ts", added: 12, removed: 3 }],
  waits,
});
const make = () => new Handoffs(depsOf());

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
  add({ chatId, runId, type: EV.runQueued, data: { access: "full" } });
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
    expect(s.text).toContain('The user\'s request: "Add a dark mode"');
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
    expect(lines("c1").at(-1)).toMatch(/^Still at its limit — tries again at (\w+ )?\d\d:\d\d$/);
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
    expect(lines("c1").at(-1)).toMatch(/^Still at its limit — tries again at (\w+ )?\d\d:\d\d$/);
  });

  // Review of 5d5785c, 2026-11-22: Always only fired when its agent was first in line. Always on Codex continues on
  // Codex while another agent (Grok Build, earlier in line) is free too.
  it("Always continues on its own agent even when another is first in line", async () => {
    ready = ["grok-build", "codex", "claude-code"];
    const data = {
      ...{ decisionId: "d1", needId: "n0", projectId: "repo", question: "When an agent hits its limit here" },
      ...{ choice: "Always continue on Codex", scope: "project", by: "you", allowKey: "handoff:codex" },
    };
    add({ chatId: null, runId: null, type: EV.decisionRecorded, data });
    hitLimit("c1", "claude-code", inAnHour());
    await until(() => started.length === 1);
    expect(started[0]).toMatchObject({ chatId: "c1", harness: "codex" });
    expect(needs.open("c1")).toEqual([]);
    expect(lines("c1")).toEqual(["Continued on Codex — Claude Code hit its limit · always here"]);
  });

  // Review of 5d5785c, 2026-11-22: a wait that went on on another agent said "· always here" without any Always.
  it("a wait that goes on on another agent doesn't say always", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    ready = ["claude-code", "codex"];
    hitLimit("c0", "codex", new Date(Date.now() + 120_000).toISOString());
    await vi.waitFor(() => {
      if (!needs.open("c0")[0]) throw new Error("not asked yet");
    });
    hitLimit("c1", "claude-code", inAnHour());
    const n = await vi.waitFor(() => {
      const open = needs.open("c1")[0];
      if (!open) throw new Error("not asked yet");
      return open;
    });
    expect(n.choices?.map((c) => c.label)).toEqual(["Wait"]);
    await handoffs.answer(n.needId, 1, "chat");
    await vi.advanceTimersByTimeAsync(121_000);
    expect(started.map((s) => [s.chatId, s.harness])).toEqual([["c1", "codex"]]);
    expect(lines("c1").at(-1)).toBe("Continued on Codex — Claude Code hit its limit");
  });

  // Review of 5d5785c, 2026-11-22: the kept decision named the agent that hit the limit, yet it applies to any.
  it("keeps Always as a decision for any agent's limit here", async () => {
    hitLimit("c1", "claude-code", inAnHour());
    const n = await until(() => needs.open("c1")[0]);
    await handoffs.answer(n.needId, 3, "chat");
    expect(decisionsView.list(db, "repo").map((x) => [x.question, x.choice, x.scope])).toEqual([
      ["When an agent hits its limit here", "Always continue on Codex", "project"],
    ]);
  });

  // Ruling, 2026-11-22: the handoff run keeps the chat's access (a Full access chat stays Full).
  it("the handoff keeps the chat's access", async () => {
    hitLimit("c1", "claude-code", inAnHour());
    const n = await until(() => needs.open("c1")[0]);
    await handoffs.answer(n.needId, 1, "chat");
    expect(started[0]?.access).toBe("full");
  });

  // Review of 5d5785c, 2026-11-22: the chat must be held from the run's end, before the question exists, so nothing
  // queued goes out on the limited agent meanwhile.
  it("holds the chat from the limited run's end until it has asked", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    handoffs.stop();
    handoffs = new Handoffs({ ...depsOf(), ready: async () => (await slow, ready) });
    hitLimit("c1", "claude-code", inAnHour());
    expect(handoffs.holding("c1")).toBe(true);
    release();
    await until(() => needs.open("c1")[0]);
    expect(handoffs.holding("c1")).toBe(true); // the open question holds it now
  });

  // Review of 5d5785c, 2026-11-22 (minor 8): a restored wait keeps how many times it has tried.
  it("a restored wait keeps its tries, and asks after the last", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    hitLimit("c1", "claude-code");
    await vi.waitFor(() => {
      if (!needs.open("c1")[0]) throw new Error("not asked yet");
    });
    await handoffs.answer(needs.open("c1")[0]!.needId, 2, "chat");
    const until0 = new Date(Date.now() + 60_000).toISOString();
    const text = "Still at its limit — tries again at 00:00";
    add({
      chatId: "c1",
      runId: null,
      type: EV.chatHandoff,
      data: { kind: "waiting", text, to: "claude-code", until: until0, guessed: true, tries: 3 },
    });
    handoffs.stop();
    waits = new Waits();
    handoffs = make();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(started.map((s) => s.harness)).toEqual(["claude-code"]);
    hitLimit("c1", "claude-code", undefined, { runId: "run_last", byIon: true });
    await vi.waitFor(() => {
      if (!needs.open("c1")[0]) throw new Error("not asked yet");
    });
  });

  // Review of 5d5785c, 2026-11-22 (minor 11): archiving a waiting chat ends its wait.
  it("archiving a waiting chat cancels its wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    hitLimit("c1", "claude-code", new Date(Date.now() + 120_000).toISOString());
    const n = await vi.waitFor(() => {
      const open = needs.open("c1")[0];
      if (!open) throw new Error("not asked yet");
      return open;
    });
    await handoffs.answer(n.needId, 2, "chat");
    add({ chatId: "c1", runId: null, type: EV.chatArchived, data: {} });
    await vi.advanceTimersByTimeAsync(121_000);
    expect(started).toEqual([]);
  });

  // Review of 5d5785c, 2026-11-22 (minor 12): ion's brief isn't one of your messages (history, search, size).
  it("keeps ion's brief out of the chat's messages", () => {
    add({ chatId: "c1", runId: null, type: EV.chatCreated, data: { title: "t", projectId: "repo" } });
    add({ chatId: "c1", runId: "r1", type: EV.messageSent, data: { text: "Add a dark mode" } });
    add({
      chatId: "c1",
      runId: "r2",
      type: EV.messageSent,
      data: { text: "ion's summary kiwi", handoff: true },
    });
    expect(messagesView.history(db, "c1", 1e6)).toEqual([{ role: "you", text: "Add a dark mode" }]);
    expect(messagesView.size(db, "c1")).toBe("Add a dark mode".length);
    expect(messagesView.search(db, "repo", "kiwi", 5)).toEqual([]);
  });

  // Review of 5d5785c, 2026-11-22 (minor 9): a try after a guessed reset that ends another way (you stopped it) ends
  // the re-checking: the next limit asks you.
  it("a try that ends any other way ends the re-checking", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    hitLimit("c1", "claude-code");
    await vi.waitFor(() => {
      if (!needs.open("c1")[0]) throw new Error("not asked yet");
    });
    await handoffs.answer(needs.open("c1")[0]!.needId, 2, "chat");
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1000);
    add({ chatId: "c1", runId: "run_try", type: EV.runQueued, data: {} });
    add({ chatId: "c1", runId: "run_try", type: EV.runFinished, data: { status: "interrupted" } });
    hitLimit("c1", "claude-code", undefined, { runId: "run_next", byIon: true });
    await vi.waitFor(() => {
      if (!needs.open("c1")[0]) throw new Error("not asked yet");
    });
    expect(needs.open("c1")).toHaveLength(1);
  });
});
