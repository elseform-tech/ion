import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EV } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { memoryView } from "../views/memory.js";
import { MemoryFiles, openMemory } from "./index.js";
import { moveNotes } from "./migrate.js";

let dir: string;
let db: Db;
let store: EventStore;
let files: MemoryFiles;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ion-memory-move-"));
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  files = new MemoryFiles({ root: join(dir, "memory"), store, db });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A note as ion kept it before memory was files. */
const note = (
  memoryId: string,
  scope: "you" | { projectId: string },
  text: string,
  source: unknown = "you",
) =>
  store.append({
    chatId: null,
    runId: null,
    origin: "daemon",
    type: EV.memoryWritten,
    data: { memoryId, scope, text, source },
  });

/** Every file's `from:` line, across the folder. */
function froms(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else out.push(...(/^from: (.+)$/m.exec(readFileSync(join(d, e.name), "utf8"))?.slice(1) ?? []));
    }
  };
  walk(join(dir, "memory"));
  return out.sort();
}

describe("moving old notes to files", () => {
  // Plan 19, Review Focus 5: every old note becomes a file, in the right folder, none lost or doubled on a restart.
  it("old notes move to files once, even if interrupted", () => {
    const chat = { chatId: "c1", runId: "r1" };
    note("ma00001", "you", "Prefers short answers.\nAnd plain words.");
    note(
      "mb00002",
      { projectId: "shop" },
      "Deploys go out on Fridays after the checks pass, never on weekends",
      chat,
    );
    note("mc00003", { projectId: "shop" }, "Forgotten one");
    note("md00004", "you", "Lives in Lisbon", { chatId: "c2", runId: "r2" });
    store.append({
      chatId: null,
      runId: null,
      origin: "daemon",
      type: EV.memoryForgotten,
      data: { memoryId: "mc00003" },
    });
    // Stopped after the first file (every write after it fails, as if ion were killed).
    const write = files.write.bind(files);
    let calls = 0;
    const spy = vi.spyOn(files, "write").mockImplementation((w) => {
      if (++calls >= 2) throw new Error("killed");
      return write(w);
    });
    // A note that fails is said and stays (tried again next time); the rest go on.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    moveNotes(files, store);
    warn.mockRestore();
    spy.mockRestore();
    // Stopped between a file and its event: the file is there, with its note's id.
    mkdirSync(join(dir, "memory", "you"), { recursive: true });
    writeFileSync(
      join(dir, "memory", "you", "lives-in-lisbon.md"),
      "---\nname: Lives in Lisbon\ndescription: Lives in Lisbon\ntype: fact\nsee: ions\nfrom: md00004\n---\n\nLives in Lisbon\n",
    );
    moveNotes(files, store);
    moveNotes(files, store);
    expect(froms()).toEqual(["ma00001", "mb00002", "md00004"]);
    const you = files.read("you/prefers-short-answers-and-plain-words.md");
    expect(you).toMatchObject({
      ok: true,
      file: {
        header: {
          name: "Prefers short answers. And plain words.",
          description: "Prefers short answers.",
          type: "fact",
          see: "ions",
          from: "ma00001",
        },
        text: "Prefers short answers.\nAnd plain words.",
      },
    });
    const shop = memoryView.search(db, { scopes: [{ projectId: "shop" }], see: ["chats"] });
    expect(shop).toMatchObject([
      {
        scope: { projectId: "shop" },
        name: "Deploys go out on Fridays after the checks pass, never on we",
        see: "chats",
        type: "fact",
        by: chat,
      },
    ]);
    // The one stopped before its event is logged as its note's, not as yours.
    expect(memoryView.get(db, "you/lives-in-lisbon.md")).toMatchObject({ by: { chatId: "c2", runId: "r2" } });
    expect(memoryView.get(db, shop[0]!.path)).toMatchObject({ by: chat });
    expect(
      store.read({ types: [EV.memoryWritten] }).filter((e) => "path" in (e.data as object)),
    ).toHaveLength(3);
    // A moved note you later delete isn't moved again.
    unlinkSync(join(dir, "memory", shop[0]!.path));
    files.reindex();
    moveNotes(files, store);
    expect(froms()).toEqual(["ma00001", "md00004"]);
  });

  // Task review, 2026-11-22: one bad old note stopped the move, and with it the daemon's start.
  it("one bad note can't stop the move, and the daemon still starts", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    note("ma00001", { projectId: "Old Shop" }, "From a project id ion can't use");
    note("mb00002", "you", "Breaks on write");
    note("mc00003", "you", "First\rline\u0007 here\nmore");
    note("md00004", { projectId: "shop" }, "From ion chief", { chatId: "ion:chief", runId: "t1" });
    const write = files.write.bind(files);
    const spy = vi.spyOn(files, "write").mockImplementation((w) => {
      if (w.text === "Breaks on write") throw new Error("disk full");
      return write(w);
    });
    expect(moveNotes(files, store)).toBe(2);
    spy.mockRestore();
    expect(froms()).toEqual(["mc00003", "md00004"]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([
        "Memory: an old note (ma00001) is for a project ion can't name (Old Shop); left as it was",
        "Memory: an old note (mb00002) couldn't move to a file (disk full); trying again next start",
      ]),
    );
    const [moved] = memoryView.search(db, { scopes: ["you"], see: ["ions"] });
    expect(moved).toMatchObject({ description: "First line  here", name: "First line here more" });
    expect(memoryView.search(db, { scopes: [{ projectId: "shop" }], see: ["chats"] })[0]).toMatchObject({
      by: { ion: "chief" },
    });
    // The next start: the daemon opens its memory (the bad note doesn't stop it), and the one that broke moves.
    expect(() => openMemory(dir, store, db)).not.toThrow();
    expect(froms()).toEqual(["mb00002", "mc00003", "md00004"]);
    warn.mockRestore();
  });
});
