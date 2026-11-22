import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EV } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { memoryView } from "../views/memory.js";
import { MemoryFiles } from "./index.js";
import { watchMemory } from "./watch.js";

let dir: string;
let db: Db;
let store: EventStore;
let files: MemoryFiles;
let stop: () => void = () => {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ion-memory-watch-"));
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  files = new MemoryFiles({ root: join(dir, "memory"), store, db });
});
afterEach(() => {
  stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Waits (up to 10 s) for `check` to pass. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  expect(check()).toBe(true);
}

describe("watching the memory folder", () => {
  // The user, 2026-11-21: "You can read and fix every file yourself": your edits are indexed and logged as yours.
  it("your edit in an editor is indexed and logged as yours", { timeout: 30_000 }, async () => {
    const chat = { chatId: "c1", runId: "r1" };
    const w = files.write({
      scope: { projectId: "shop" },
      header: { name: "Deploys", description: "How we ship", type: "fact" },
      text: "Fridays",
      by: chat,
    });
    stop = watchMemory(files, { debounceMs: 30 });
    const path = join(dir, "memory", w.path);
    writeFileSync(
      path,
      "---\nname: Deploys\ndescription: How we ship now\ntype: fact\n---\nMondays, via CI\n",
    );
    await until(() => memoryView.get(db, w.path)?.description === "How we ship now");
    const scopes = { scopes: [{ projectId: "shop" }], see: ["chats" as const] };
    expect(memoryView.search(db, { ...scopes, q: "CI" }).map((r) => r.path)).toEqual([w.path]);
    const events = store.read({ types: [EV.memoryWritten] });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ data: { by: "you", before: { hash: w.hash, text: "Fridays" } } });
    // A new file of yours, and one you deleted.
    writeFileSync(
      join(dir, "memory", "projects", "shop", "keys.md"),
      "---\nname: Keys\ndescription: k\n---\nx\n",
    );
    unlinkSync(path);
    await until(
      () => memoryView.get(db, w.path) === undefined && !!memoryView.get(db, "projects/shop/keys.md"),
    );
    expect(store.read({ types: [EV.memoryForgotten] })).toMatchObject([
      { data: { path: w.path, by: "you", before: { text: "Mondays, via CI" } } },
    ]);
    // ion's own write isn't taken for yours.
    files.write({
      scope: "you",
      header: { name: "Mine", description: "m", type: "fact" },
      text: "x",
      by: chat,
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(
      store.read({ types: [EV.memoryWritten] }).filter((e) => (e.data as { by: unknown }).by !== "you"),
    ).toHaveLength(2);
  });
});
