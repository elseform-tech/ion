import { estimateText, type NewEvent, type UsageWindow } from "@ion/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, EventStore, openDb } from "../store/index.js";
import { estimateOf } from "./estimate.js";
import { allViews } from "./index.js";

let db: Db;
let store: EventStore;
let n = 0;
/** The events' clock: a minute per event, so runs don't overlap unless a test says so. */
let clock = 0;
const T0 = Date.parse("2026-11-23T08:00:00Z");

beforeEach(() => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  n = 0;
  clock = 0;
});

const RESETS = "2026-11-23T13:00:00.000Z";
const EDIT = "Rename the helper in utils and update its callers";
const QUESTION = "Why does the build fail on CI?";

type Past = {
  project?: string;
  harness?: string;
  text?: string;
  /** Tokens per run (several: a chat with several runs). */
  tokens?: number[];
  cost?: number;
  /** The agent's count was partial: no total (opencode's last step only). */
  partial?: boolean;
  /** The 5 h window's used percent each run reported. */
  used?: number[];
  /** The window's reset as this chat's runs reported it, when it differs (seconds off). */
  resetsOffS?: number;
};

const add = (ids: [string, string | null], type: string, data: object, origin = "daemon") =>
  store.append({
    ...{ chatId: ids[0], runId: ids[1], origin, type, data },
    ts: new Date(T0 + ++clock * 60_000).toISOString(),
  } as NewEvent);

const start = (chatId: string, runId: string, harness: string) =>
  add([chatId, runId], "run.started", { harness, model: "m", effort: null, authMethod: null }, "adapter");

function usage(p: Past, t: number, i: number) {
  const resetsAt = new Date(Date.parse(RESETS) + (p.resetsOffS ?? 0) * 1000).toISOString();
  const windows: UsageWindow[] | undefined =
    p.used?.[i] === undefined ? undefined : [{ name: "5 h", usedPercent: p.used[i]!, resetsAt }];
  const u = {
    ...{ model: "m", inputTokens: t - 1000, outputTokens: 1000, costUsd: p.cost ?? null },
    ...(p.partial ? {} : { totalTokens: t }),
  };
  return windows ? { ...u, windows } : u;
}

/** One past chat, as its events say: your request, its runs and their usage. */
function chat(p: Past = {}): string {
  const chatId = `c${++n}`;
  add([chatId, null], "chat.created", { title: "t", projectId: p.project ?? "app" });
  add([chatId, null], "message.sent", { text: p.text ?? EDIT });
  (p.tokens ?? [50_000]).forEach((t, i) => {
    const runId = `${chatId}-r${i}`;
    start(chatId, runId, p.harness ?? "opencode");
    add([chatId, runId], "usage.reported", usage(p, t, i), "adapter");
    add([chatId, runId], "run.finished", { status: "done" });
  });
  return chatId;
}

/** Chats that each moved Codex's 5 h window by these steps, after one (in another project) that set where it stood. */
function codexSteps(steps: number[], p: Past = {}): number {
  chat({ harness: "codex", project: "web", used: [10] });
  let at = 10;
  for (const step of steps) {
    at += step;
    chat({ ...p, harness: "codex", used: [at] });
  }
  return at;
}

const FREE = { billing: "free" as const, windows: [] };
const ask = (text = EDIT, harness = "opencode") => ({ projectId: "app", harness, text });
const sub = (usedPercent: number) => ({
  billing: "subscription" as const,
  windows: [{ name: "5 h", usedPercent, resetsAt: RESETS }],
});

describe("estimateOf", () => {
  // The user, 2026-11-21: "With fewer than 5 similar chats, there's no estimate rather than a guess."
  it("no estimate with under 5 similar chats", () => {
    for (let i = 0; i < 4; i++) chat();
    // Not similar: another project, another agent, a question, a much longer request.
    chat({ project: "web" });
    chat({ harness: "grok" });
    chat({ text: QUESTION });
    chat({ text: `${EDIT} ${"and more ".repeat(200)}` });
    expect(estimateOf(db, ask(), FREE)).toBeNull();
    // The same request with spaces around it is the same length (both sides measure it the same way).
    chat({ text: `  ${EDIT}  ` });
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
    for (const t of [2000, 3000, 4000, 5000, 6000]) chat({ text: QUESTION, tokens: [t] });
    expect(estimateText(estimateOf(db, ask(QUESTION), FREE)!)).toBe("usually 4–6k tokens");
  });

  // Final review, 2026-11-23: a chat that went on on another agent (a handoff) counts only part of its work on each:
  // it's left out of both agents' estimates.
  it("leaves out chats whose runs span agents", () => {
    for (const t of [10_000, 20_000, 60_000, 100_000, 120_000]) {
      const chatId = chat({ tokens: [t] });
      start(chatId, `${chatId}-g`, "grok-build");
      add([chatId, `${chatId}-g`], "usage.reported", usage({}, 5000, 0), "adapter");
    }
    expect(estimateOf(db, ask(), FREE)).toBeNull();
  });

  // Review of fb615b0, 2026-11-23: the estimate counted a fragment of opencode's tokens (its last step only). An
  // agent whose counts are partial never shows a token estimate (verify, don't guess).
  it("an agent whose counts are partial shows no token estimate", () => {
    for (let i = 0; i < 6; i++) chat({ partial: true });
    expect(estimateOf(db, ask(), FREE)).toBeNull();
  });

  // Review of fb615b0, 2026-11-23: past chats were split by the files they changed, new requests by their words, so
  // the two disagreed. One rule for both: a request ending in "?" is a question.
  it("a request ending in '?' that asks for a change is a question on both sides", () => {
    const ASKS = "Can you rename the helper in utils?";
    for (let i = 0; i < 5; i++) chat({ text: ASKS, tokens: [8000] });
    expect(estimateOf(db, ask("Could you add a test for the cart?"), FREE)).toMatchObject({ high: 8000 });
    expect(estimateOf(db, ask("Add a test for the cart"), FREE)).toBeNull();
    // No list of question words: "Why …" without "?" reads as a change, like the chats above don't.
    expect(estimateOf(db, ask("Why not add a test for the cart"), FREE)).toBeNull();
  });
});

describe("estimateOf, as it's shown", () => {
  // The user, 2026-11-21: "For api-billed agents, it's shown as cost. Otherwise it's shown as share of the window."
  it("api shows cost, subscriptions show share", () => {
    for (const c of [0.2, 0.3, 0.4, 0.5, 0.6]) chat({ harness: "claude-code", cost: c });
    const api = estimateOf(db, ask(EDIT, "claude-code"), { billing: "api", windows: [] });
    expect(estimateText(api!)).toBe("usually $0.40–$0.60");
    // The chat before them set where the window stood; each chat's share is how far it moved the window.
    const at = codexSteps([3, 5, 5, 8, 10]);
    expect(estimateText(estimateOf(db, ask(EDIT, "codex"), sub(at))!)).toBe("usually 5–10% of 5 h");
  });

  // The user, 2026-11-22 ("verify, don't guess"): share of a window only when the agent reports real windows;
  // otherwise tokens.
  it("share of a window only from windows the agent really reports", () => {
    codexSteps([3, 5, 5, 8, 10]);
    // It reports no window now: tokens, never a made-up share.
    const none = estimateOf(db, ask(EDIT, "codex"), { billing: "subscription", windows: [] });
    expect(none?.unit).toBe("tokens");
    // Its past chats reported no windows: tokens too.
    for (let i = 0; i < 5; i++) chat({ harness: "grok" });
    expect(estimateOf(db, ask(EDIT, "grok"), sub(20))?.unit).toBe("tokens");
  });

  // Review of fb615b0, 2026-11-23: an agent's reset time wobbles by a few seconds between reports; it's the same
  // window. A chat whose run overlapped another run on the agent can't say what it alone used.
  it("a window's share allows a few seconds of reset wobble, and skips overlapping runs", () => {
    const at = codexSteps([3, 5, 5, 8, 10], { resetsOffS: 20 });
    expect(estimateOf(db, ask(EDIT, "codex"), sub(at))?.unit).toBe("percent");
    // Another run on Codex went on during the last chat's run: that chat's share can't be told (4 left: tokens).
    const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
    db.prepare("UPDATE view_runs SET started_at = ? WHERE run_id = ?").run(iso(0), "c6-r0");
    start("other", "other-r0", "codex");
    db.prepare("UPDATE view_runs SET started_at = ?, finished_at = ? WHERE run_id = ?").run(
      iso(1),
      iso(2),
      "other-r0",
    );
    expect(estimateOf(db, ask(EDIT, "codex"), sub(at))?.unit).toBe("tokens");
  });

  // Review of fb615b0, 2026-11-23: 999,600 tokens read "1000k"; a tiny cost read "$0.00".
  it("reads round figures", () => {
    expect(estimateText({ unit: "tokens", low: 400_000, high: 999_600 })).toBe("usually 400k–1M tokens");
    expect(estimateText({ unit: "usd", low: 0.001, high: 0.004 })).toBe("usually under $0.01");
    expect(estimateText({ unit: "usd", low: 0.004, high: 0.05 })).toBe("usually under $0.05");
  });
});
