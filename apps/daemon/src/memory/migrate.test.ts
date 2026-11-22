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
import { MemoryFiles } from "./index.js";
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
    // Stopped after the first file.
    const write = files.write.bind(files);
    let calls = 0;
    const spy = vi.spyOn(files, "write").mockImplementation((w) => {
      if (++calls === 2) throw new Error("killed");
      return write(w);
    });
    expect(() => moveNotes(files, store)).toThrow("killed");
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
    const shop = memoryView.search(db, { scopes: ["shop"], see: ["chats"] });
    expect(shop).toMatchObject([
      {
        scope: "shop",
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
});
