import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { EV, type IonCard } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { Suggestions } from "./suggestions.js";

// November 2026: the 6th and 13th are Fridays; ion looks on Thursday the 19th, at noon.
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);
const HOUR = 3_600_000;

let db: Db;
let store: EventStore;
let configFile: string;
let changes: ReturnType<typeof vi.fn>;
let addRoutine: ReturnType<typeof vi.fn>;
let resume: ReturnType<typeof vi.fn>;
let stops: (() => void)[] = [];

const projects = [
  { id: "storefront", path: "/p/storefront", starred: false },
  { id: "default", path: "/p/default", starred: false },
  { id: "private", path: "/p/private", starred: false, shareWithIon: false },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(19, 12));
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  configFile = join(mkdtempSync(join(tmpdir(), "ion-sugg-")), "config.toml");
  saveUserConfig(configFile, { ...DEFAULT_CONFIG, projects });
  changes = vi.fn(async () => 3);
  addRoutine = vi.fn();
  resume = vi.fn(async () => {});
});

afterEach(() => {
  for (const s of stops) s();
  stops = [];
  vi.useRealTimers();
});

/** ion's daemon starting (a restart is a new one over the same store). */
function boot(): Suggestions {
  const s = new Suggestions({ store, db, configFile, changes, addRoutine, resume });
  stops.push(s.start());
  return s;
}

const append = (chatId: string, type: string, data: Record<string, unknown>, when: Date) =>
  store.append({ chatId, runId: null, origin: "daemon", type: type as never, data, ts: when.toISOString() });

/** You asked a project's ion. */
const tellIon = (projectId: string, text: string, when: Date) =>
  append(`ion:${projectId}`, EV.ionHeard, { text }, when);

/** A chat you started; its last run ended `status` at `when`. */
function chatOf(
  chatId: string,
  projectId: string,
  title: string,
  o: { at: Date; status?: string; by?: "ion" },
) {
  const { at: when, status = "done", by } = o;
  append(chatId, EV.chatCreated, { title, projectId, ...(by ? { by } : {}) }, when);
  append(chatId, EV.messageSent, { text: title }, when);
  append(chatId, EV.runFinished, { status }, when);
}

const cards = () =>
  store
    .read({ chatId: "ion:chief" })
    .filter((e) => e.type === EV.ionSaid)
    .map((e) => (e.data as { card?: IonCard }).card!)
    .filter(Boolean);

const answers = () =>
  store
    .read({ chatId: "ion:chief" })
    .filter((e) => e.type === EV.suggestionAnswered)
    .map((e) => e.data);

const prSummary = (projectId = "storefront") => {
  tellIon(projectId, "Summarize this week's PRs", at(6, 17, 2));
  tellIon(projectId, "summarize this week's PRs.", at(13, 16, 50));
  chatOf("c-pr", projectId, "Summarize this week's PRs", { at: new Date(2026, 9, 30, 17, 20) });
};

// Plan 11: ion chief suggests routines for what you keep asking for.
describe("routine suggestions", () => {
  it("suggests a routine when you asked for the same thing on 3 days, once", async () => {
    prSummary();
    boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(cards()).toEqual([
      {
        kind: "routine",
        suggestionId: expect.any(String),
        projectId: "storefront",
        key: "summarize this week s prs",
        name: "Summarize this week's PRs",
        text: "summarize this week's PRs.",
        when: "fri 17:00",
        dates: [at(13, 16, 50), at(6, 17, 2), new Date(2026, 9, 30, 17, 20)].map((d) => d.toISOString()),
      },
    ]);
    const said = store.read({ chatId: "ion:chief" }).find((e) => e.type === EV.ionSaid)!.data;
    expect((said as { text: string }).text).toBe("Make “Summarize this week's PRs” a routine?");
    // An hour on, and after a restart: never twice.
    await vi.advanceTimersByTimeAsync(HOUR);
    boot();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(cards()).toHaveLength(1);
  });

  it("never suggests for default, a project kept from ion, or ion's own threads", async () => {
    prSummary("default");
    prSummary("private");
    chatOf("t1", "storefront", "Run the e2e suite", { at: at(16, 9), status: "done", by: "ion" });
    chatOf("t2", "storefront", "Run the e2e suite", { at: at(17, 9), status: "done", by: "ion" });
    chatOf("t3", "storefront", "Run the e2e suite", { at: at(18, 9), status: "done", by: "ion" });
    boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(cards()).toEqual([]);
  });

  it("skips what's already a routine", async () => {
    saveUserConfig(configFile, {
      ...DEFAULT_CONFIG,
      projects: [
        {
          ...projects[0]!,
          routines: [
            { id: "prs", name: "PRs", when: "fri 17:00", text: "Summarize this week's PRs", on: true },
          ],
        },
      ],
    });
    prSummary();
    boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(cards()).toEqual([]);
  });

  it("adds the routine when you take it, and records your answer", async () => {
    prSummary();
    const s = boot();
    await vi.advanceTimersByTimeAsync(0);
    const [card] = cards();
    expect(s.list()).toEqual([
      {
        suggestionId: card!.kind === "routine" && card.suggestionId,
        kind: "routine",
        projectId: "storefront",
        title: "Make “Summarize this week's PRs” a routine?",
        detail: "Fridays 17:00 · asked on 3 days",
        at: expect.any(String),
      },
    ]);
    await s.answer(s.list()[0]!.suggestionId, { keep: true });
    expect(addRoutine).toHaveBeenCalledWith("storefront", {
      name: "Summarize this week's PRs",
      when: "fri 17:00",
      text: "summarize this week's PRs.",
    });
    expect(answers()).toEqual([{ suggestionId: expect.any(String), keep: true }]);
    expect(s.list()).toEqual([]);
    await expect(s.answer(answers()[0]!.suggestionId as string, { keep: true })).rejects.toThrow(
      "That suggestion is gone",
    );
  });

  it("records Not now and mute; a muted project gets no more", async () => {
    prSummary();
    const s = boot();
    await vi.advanceTimersByTimeAsync(0);
    await s.answer(s.list()[0]!.suggestionId, { keep: false, mute: true });
    expect(addRoutine).not.toHaveBeenCalled();
    expect(answers()).toEqual([{ suggestionId: expect.any(String), keep: false, mute: true }]);
    tellIon("storefront", "Run the e2e suite", at(16, 9));
    tellIon("storefront", "Run the e2e suite", at(17, 9));
    tellIon("storefront", "Run the e2e suite", at(18, 9));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(cards()).toHaveLength(1);
  });

  it("says why it couldn't add it, and keeps it open", async () => {
    prSummary();
    addRoutine.mockImplementation(() => {
      throw new Error("Fix your config first");
    });
    const s = boot();
    await vi.advanceTimersByTimeAsync(0);
    await expect(s.answer(s.list()[0]!.suggestionId, { keep: true })).rejects.toThrow(
      "Fix your config first",
    );
    expect(answers()).toEqual([]);
    expect(s.list()).toHaveLength(1);
  });
});

// Plan 11: a chat of yours that failed or was stopped, untouched for 3 days, with changes, gets a "Resume?" card.
describe("stalled-work suggestions", () => {
  it("suggests resuming a chat stalled 3 days with changes, once", async () => {
    chatOf("c1", "storefront", "Tailwind 4 migration", { at: at(13, 10), status: "failed" });
    const s = boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(cards()).toEqual([
      {
        kind: "stalled",
        suggestionId: expect.any(String),
        chatId: "c1",
        projectId: "storefront",
        title: "Tailwind 4 migration",
        since: at(13, 10).toISOString(),
        files: 3,
      },
    ]);
    expect(changes).toHaveBeenCalledWith("c1");
    expect(s.list()[0]).toMatchObject({
      kind: "stalled",
      title: "Resume “Tailwind 4 migration”?",
      detail: "Stalled 6 days · 3 files",
    });
    await vi.advanceTimersByTimeAsync(HOUR);
    boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(cards()).toHaveLength(1);
  });

  it("skips chats that are fine, recent, ion's, archived, kept from ion, or without changes", async () => {
    chatOf("ok", "storefront", "Done one", { at: at(10, 10), status: "done" });
    chatOf("new", "storefront", "Recent one", { at: at(17, 10), status: "failed" });
    chatOf("ion", "storefront", "ion's one", { at: at(10, 10), status: "failed", by: "ion" });
    chatOf("arch", "storefront", "Archived one", { at: at(10, 10), status: "interrupted" });
    append("arch", EV.chatArchived, {}, at(10, 11));
    chatOf("priv", "private", "Private one", { at: at(10, 10), status: "failed" });
    chatOf("clean", "storefront", "No changes", { at: at(10, 10), status: "interrupted" });
    changes.mockImplementation(async (chatId: string) => (chatId === "clean" ? 0 : 3));
    boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(cards()).toEqual([]);
    expect(changes.mock.calls.map((c) => c[0])).toEqual(["clean"]);
  });

  it("resumes the chat when you take it; Not now is recorded", async () => {
    chatOf("c1", "storefront", "Tailwind 4 migration", { at: at(13, 10), status: "interrupted" });
    chatOf("c2", "storefront", "Old refactor", { at: at(12, 10), status: "failed" });
    const s = boot();
    await vi.advanceTimersByTimeAsync(0);
    const [a, b] = s.list();
    await s.answer(a!.suggestionId, { keep: true });
    expect(resume).toHaveBeenCalledWith("c1");
    await s.answer(b!.suggestionId, { keep: false });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(answers()).toEqual([
      { suggestionId: a!.suggestionId, keep: true },
      { suggestionId: b!.suggestionId, keep: false },
    ]);
  });

  it("comes back only when the chat is touched again and stalls again", async () => {
    chatOf("c1", "storefront", "Tailwind 4 migration", { at: at(13, 10), status: "failed" });
    const s = boot();
    await vi.advanceTimersByTimeAsync(0);
    await s.answer(s.list()[0]!.suggestionId, { keep: false });
    append("c1", EV.messageSent, { text: "Try again" }, at(19, 13));
    append("c1", EV.runFinished, { status: "failed" }, at(19, 13));
    await vi.advanceTimersByTimeAsync(2 * 86_400_000);
    expect(cards()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(86_400_000 + HOUR);
    expect(cards()).toHaveLength(2);
    expect(cards()[1]).toMatchObject({ chatId: "c1", since: at(19, 13).toISOString() });
  });

  it("drops an open card once its chat is touched again", async () => {
    chatOf("c1", "storefront", "Tailwind 4 migration", { at: at(13, 10), status: "failed" });
    const s = boot();
    await vi.advanceTimersByTimeAsync(0);
    append("c1", EV.messageSent, { text: "Go on" }, at(19, 13));
    expect(s.list()).toEqual([]);
  });
});
