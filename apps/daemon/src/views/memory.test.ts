import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EV, type MemoryType } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryFiles } from "../memory/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "./index.js";
import { memoryView } from "./memory.js";

let dir: string;
let db: Db;
let store: EventStore;
let files: MemoryFiles;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ion-memory-view-"));
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  files = new MemoryFiles({ root: join(dir, "memory"), store, db });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fact = (name: string, description: string, type: MemoryType = "fact") => ({ name, description, type });
const all = { see: ["chats" as const, "ions" as const] };
const paths = (rows: { path: string }[]) => rows.map((r) => r.path);

describe("the memory index", () => {
  // The user, 2026-11-21: "sqlite for indexes and history (quick search) and memory for details".
  it("search finds by name, description and text, quickly (500 files < 50 ms)", () => {
    for (let i = 0; i < 497; i++)
      files.write({
        scope: { projectId: "shop" },
        header: fact(`Note ${i}`, `Filler ${i}`),
        text: "x",
        by: "you",
      });
    const byName = files.write({
      scope: { projectId: "shop" },
      header: fact("Stripe keys", "k"),
      text: "a",
      by: "you",
    });
    const byDesc = files.write({
      scope: { projectId: "shop" },
      header: fact("Billing", "Rotate monthly"),
      text: "b",
      by: "you",
    });
    const byText = files.write({
      scope: "you",
      header: fact("Me", "who", "person"),
      text: "Lives in Lisbon",
      by: "you",
    });
    const scopes = { scopes: ["you", { projectId: "shop" }], ...all };
    expect(paths(memoryView.search(db, { ...scopes, q: "stripe" }))).toEqual([byName.path]);
    expect(paths(memoryView.search(db, { ...scopes, q: "rotate" }))).toEqual([byDesc.path]);
    expect(paths(memoryView.search(db, { ...scopes, q: "lisbon" }))).toEqual([byText.path]);
    expect(memoryView.search(db, scopes)).toHaveLength(500);
    // Task review, 2026-11-22: one timed pass failed under a loaded machine (79 ms). Warmed up, then the median of 5
    // passes, and a guard that doesn't depend on the machine: 500 files cost at most ~20× one file.
    const pass = (q: typeof scopes) => () => {
      for (const word of ["stripe", "rotate", "lisbon"]) memoryView.search(db, { ...q, q: word });
      memoryView.search(db, q);
    };
    const median = (run: () => void) => {
      run();
      const times = Array.from({ length: 5 }, () => {
        const t = performance.now();
        run();
        return performance.now() - t;
      });
      return times.sort((a, b) => a - b)[2]!;
    };
    const many = median(pass(scopes));
    const one = median(pass({ scopes: ["you"], ...all }));
    expect(many).toBeLessThan(50);
    expect(many).toBeLessThan(Math.max(one, 0.5) * 20);
    // Only the scopes and the `see` asked for; FTS syntax in a query is plain words.
    expect(memoryView.search(db, { scopes: [{ projectId: "shop" }], ...all, q: "lisbon" })).toEqual([]);
    expect(memoryView.search(db, { scopes: ["you"], see: ["chats"], q: "lisbon" })).toEqual([]);
    expect(memoryView.search(db, { ...scopes, q: 'NEAR(") *' })).toEqual([]);
    expect(paths(memoryView.search(db, { ...scopes, type: "person" }))).toEqual([byText.path]);
  });

  it("lists open to-dos first, then by last change", () => {
    const todo = (name: string, status: "open" | "done") => ({ ...fact(name, name, "todo"), status });
    const open = files.write({ scope: "you", header: todo("Rotate keys", "open"), text: "x", by: "you" });
    const done = files.write({ scope: "you", header: todo("Old", "done"), text: "x", by: "you" });
    const later = files.write({ scope: "you", header: fact("Later", "l"), text: "x", by: "you" });
    expect(paths(memoryView.search(db, { scopes: ["you"], ...all }))).toEqual([
      open.path,
      later.path,
      done.path,
    ]);
    expect(paths(memoryView.search(db, { scopes: ["you"], ...all, status: "open" }))).toEqual([open.path]);
  });

  // The user, 2026-11-21: the files are the truth; deleting the index rebuilds it from them.
  it("the index is rebuilt from the files", () => {
    const a = files.write({ scope: "you", header: fact("Tea", "Drinks"), text: "Green tea", by: "you" });
    files.write({ scope: { projectId: "shop" }, header: fact("Ship", "s"), text: "Fridays", by: "you" });
    const before = memoryView.search(db, { scopes: ["you", { projectId: "shop" }], ...all });
    const events = store.read({}).length;
    // The index goes (a view upgrade, or the tables dropped): rebuilt from the log and the files, nothing logged.
    store.rebuildViews();
    files.reindex();
    expect(memoryView.search(db, { scopes: ["you", { projectId: "shop" }], ...all })).toEqual(before);
    expect(paths(memoryView.search(db, { scopes: ["you"], ...all, q: "green" }))).toEqual([a.path]);
    expect(store.read({})).toHaveLength(events);
    // A new database: every file is indexed again (logged as yours, since ion never saw it).
    const db2 = openDb(":memory:");
    const files2 = new MemoryFiles({
      root: join(dir, "memory"),
      store: new EventStore(db2, allViews),
      db: db2,
    });
    files2.reindex();
    expect(
      paths(memoryView.search(db2, { scopes: ["you", { projectId: "shop" }], ...all, q: "fridays" })),
    ).toEqual(["projects/shop/ship.md"]);
  });

  // The user, 2026-11-21: "sqlite for indexes and history": who changed what, when, and the text before.
  it("history keeps each change and the text before", () => {
    const chat = { chatId: "c1", runId: "r1" };
    const one = files.write({ scope: "you", header: fact("Tea", "Drinks"), text: "Green tea", by: chat });
    const two = files.write({
      ...{ scope: "you" as const, slug: one.slug, header: fact("Tea", "Drinks"), text: "Black tea" },
      ...{ expectHash: one.hash, by: { ion: "chief" } },
    });
    const path = join(dir, "memory", one.path);
    writeFileSync(path, "---\nname: Tea\ndescription: Drinks\n---\nNo tea\n");
    files.sync(one.path);
    unlinkSync(path);
    files.sync(one.path);
    const h = memoryView.history(db, one.path);
    expect(h.map((c) => [c.kind, c.by, c.before?.text])).toEqual([
      ["written", chat, undefined],
      ["written", { ion: "chief" }, "Green tea"],
      ["written", "you", "Black tea"],
      ["forgotten", "you", "No tea"],
    ]);
    expect(h[1]).toMatchObject({ hash: two.hash, header: { name: "Tea" }, before: { hash: one.hash } });
    expect(h.every((c) => typeof c.at === "string")).toBe(true);
    // History is ion's events: a rebuild keeps it.
    store.rebuildViews();
    expect(memoryView.history(db, one.path)).toEqual(h);
    expect(store.read({ types: [EV.memoryForgotten] })).toHaveLength(1);
  });
});
