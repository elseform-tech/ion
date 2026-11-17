import { EV } from "@ion/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { UserError } from "../api/errors.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { memoryView } from "../views/memory.js";
import { forgetMemory, writeMemory } from "./index.js";

let db: Db;
let store: EventStore;

beforeEach(() => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
});

describe("memory", () => {
  it("keeps each project's memory to itself, and yours shows everywhere", () => {
    writeMemory(store, db, {
      scope: { projectId: "app" },
      text: "Tests use vitest",
      source: { chatId: "c1", runId: "r1" },
    });
    writeMemory(store, db, { scope: { projectId: "shop" }, text: "Deploys on Fridays", source: "you" });
    writeMemory(store, db, { scope: "you", text: "Prefer short answers", source: "you" });
    expect(memoryView.list(db, "app").map((m) => m.text)).toEqual([
      "Tests use vitest",
      "Prefer short answers",
    ]);
    expect(memoryView.list(db, null)).toHaveLength(3);
    expect(memoryView.list(db, "app")[0]).toMatchObject({ scope: "app", source: "c1" });
  });

  it("forgets a memory, and says so for one it doesn't know", () => {
    const id = writeMemory(store, db, { scope: "you", text: "x", source: "you" });
    expect(id).toMatch(/^m[0-9a-f]{6}$/);
    forgetMemory(store, db, id);
    expect(memoryView.list(db, null)).toEqual([]);
    expect(store.read({}).at(-1)).toMatchObject({ type: EV.memoryForgotten, data: { memoryId: id } });
    expect(() => forgetMemory(store, db, "nope")).toThrow(new UserError("Unknown memory: nope"));
  });

  it("refuses an empty memory or one over 2000 characters", () => {
    expect(() => writeMemory(store, db, { scope: "you", text: "x".repeat(2001), source: "you" })).toThrow(
      new UserError("A memory can be 2000 characters at most"),
    );
    expect(() => writeMemory(store, db, { scope: "you", text: "  ", source: "you" })).toThrow(UserError);
  });

  it("rebuilds the same list from the log", () => {
    writeMemory(store, db, { scope: "you", text: "a", source: "you" });
    const before = memoryView.list(db, null);
    store.rebuildViews();
    expect(memoryView.list(db, null)).toEqual(before);
  });

  // Final review minor 7: an id that's already taken is drawn again, never overwritten.
  it("never reuses a memory id", () => {
    const ids = ["mabc123", "mabc123", "mdef456"];
    const first = writeMemory(store, db, { scope: "you", text: "one", source: "you" }, () => ids.shift()!);
    const second = writeMemory(store, db, { scope: "you", text: "two", source: "you" }, () => ids.shift()!);
    expect([first, second]).toEqual(["mabc123", "mdef456"]);
    expect(memoryView.list(db, null).map((m) => m.text)).toEqual(["one", "two"]);
  });
});
