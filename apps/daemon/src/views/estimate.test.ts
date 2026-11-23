import { estimateText, type NewEvent, type UsageWindow } from "@ion/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, EventStore, openDb } from "../store/index.js";
import { estimateOf } from "./estimate.js";
import { allViews } from "./index.js";

let db: Db;
let store: EventStore;
let n = 0;

beforeEach(() => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  n = 0;
});

const RESETS = new Date(Date.now() + 3 * 3_600_000).toISOString();
const EDIT = "Rename the helper in utils and update its callers";
const QUESTION = "Why does the build fail on CI?";

type Past = {
  project?: string;
  harness?: string;
  text?: string;
  /** Tokens per run (several: a chat with several runs). */
  tokens?: number[];
  cost?: number;
  edited?: boolean;
  /** The 5 h window's used percent each run reported. */
  used?: number[];
};

const add = (ids: [string, string | null], type: string, data: object, origin = "daemon") =>
  store.append({ chatId: ids[0], runId: ids[1], origin, type, data } as NewEvent);

/** One past chat, as its events say: your request, its runs (their usage), the files it changed. */
function chat(p: Past = {}): string {
  const chatId = `c${++n}`;
  add([chatId, null], "chat.created", { title: "t", projectId: p.project ?? "app" });
  add([chatId, null], "message.sent", { text: p.text ?? EDIT });
  const tokens = p.tokens ?? [50_000];
  tokens.forEach((t, i) => {
    const runId = `${chatId}-r${i}`;
    add(
      [chatId, runId],
      "run.started",
      { harness: p.harness ?? "opencode", model: "m", effort: null, authMethod: null },
      "adapter",
    );
    if (p.edited ?? true)
      add([chatId, runId], "file.changed", { path: "a.ts", change: "modify", added: 1, removed: 1 });
    const windows: UsageWindow[] | undefined =
      p.used?.[i] === undefined ? undefined : [{ name: "5 h", usedPercent: p.used[i]!, resetsAt: RESETS }];
    const usage = { model: "m", inputTokens: t - 1000, outputTokens: 1000, costUsd: p.cost ?? null };
    add([chatId, runId], "usage.reported", windows ? { ...usage, windows } : usage, "adapter");
    add([chatId, runId], "run.finished", { status: "done" });
  });
  return chatId;
}

const FREE = { billing: "free" as const, windows: [] };
const ask = (text = EDIT, harness = "opencode") => ({ projectId: "app", harness, text });

describe("estimateOf", () => {
  // The user, 2026-11-21: "With fewer than 5 similar chats, there's no estimate rather than a guess."
  it("no estimate with under 5 similar chats", () => {
    for (let i = 0; i < 4; i++) chat();
    // Not similar: another project, another agent, a question (no files changed), a much longer request.
    chat({ project: "web" });
    chat({ harness: "grok" });
    chat({ edited: false });
    chat({ text: `${EDIT} ${"and more ".repeat(200)}` });
    expect(estimateOf(db, ask(), FREE)).toBeNull();
    chat();
    expect(estimateOf(db, ask(), FREE)).not.toBeNull();
  });

  // The user, 2026-11-21: the estimate is a range from similar past chats in that project ("usually 40–120k tokens").
  it("the range comes from the project's history", () => {
    for (const t of [10_000, 20_000, 60_000, 100_000, 120_000]) chat({ tokens: [t] });
    // A chat's total is all its runs.
    chat({ tokens: [25_000, 15_000] });
    // Other projects' chats don't count.
    for (let i = 0; i < 5; i++) chat({ project: "web", tokens: [900_000] });
    const e = estimateOf(db, ask(), FREE);
    expect(e).toEqual({ unit: "tokens", low: 40_000, high: 120_000 });
    expect(estimateText(e!)).toBe("usually 40–120k tokens");
    // A question is estimated from past questions.
    for (const t of [2000, 3000, 4000, 5000, 6000]) chat({ edited: false, text: QUESTION, tokens: [t] });
    expect(estimateText(estimateOf(db, ask(QUESTION), FREE)!)).toBe("usually 4–6k tokens");
  });

  // The user, 2026-11-21: "For api-billed agents, it's shown as cost. Otherwise it's shown as share of the window."
  it("api shows cost, subscriptions show share", () => {
    for (const c of [0.2, 0.3, 0.4, 0.5, 0.6]) chat({ harness: "claude-code", cost: c });
    const api = estimateOf(db, ask(EDIT, "claude-code"), { billing: "api", windows: [] });
    expect(estimateText(api!)).toBe("usually $0.40–$0.60");
    // The chat before them set where the window stood; each chat's share is how far it moved the window.
    chat({ harness: "codex", project: "web", used: [10] });
    let at = 10;
    for (const step of [3, 5, 5, 8, 10]) {
      at += step;
      chat({ harness: "codex", used: [at] });
    }
    const now = [{ name: "5 h", usedPercent: at, resetsAt: RESETS }];
    const sub = estimateOf(db, ask(EDIT, "codex"), { billing: "subscription", windows: now });
    expect(estimateText(sub!)).toBe("usually 5–10% of 5 h");
  });

  // The user, 2026-11-22 ("verify, don't guess"): share of a window only when the agent reports real windows;
  // otherwise tokens.
  it("share of a window only from windows the agent really reports", () => {
    chat({ harness: "codex", used: [10] });
    let at = 10;
    for (const step of [3, 5, 5, 8, 10]) {
      at += step;
      chat({ harness: "codex", used: [at] });
    }
    // It reports no window now: tokens, never a made-up share.
    const none = estimateOf(db, ask(EDIT, "codex"), { billing: "subscription", windows: [] });
    expect(none?.unit).toBe("tokens");
    // Its past chats reported no windows: tokens too.
    for (let i = 0; i < 5; i++) chat({ harness: "grok" });
    const grok = estimateOf(db, ask(EDIT, "grok"), {
      billing: "subscription",
      windows: [{ name: "5 h", usedPercent: 20, resetsAt: RESETS }],
    });
    expect(grok?.unit).toBe("tokens");
  });
});
