import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EV } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserError } from "../api/errors.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { MemoryFiles } from "./index.js";

let dir: string;
let db: Db;
let store: EventStore;
let memory: MemoryFiles;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ion-memory-"));
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  memory = new MemoryFiles({ root: join(dir, "memory"), store, db });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("memory", () => {
  it("keeps each project's memory to itself, and yours shows everywhere", () => {
    memory.note({ projectId: "app" }, "Tests use vitest", { chatId: "c1", runId: "r1" });
    memory.note({ projectId: "shop" }, "Deploys on Fridays", "you");
    memory.note("you", "Prefer short answers", "you");
    expect(memory.list("app", ["chats", "ions"]).map((m) => m.text)).toEqual([
      "Tests use vitest",
      "Prefer short answers",
    ]);
    expect(memory.list(null, ["chats", "ions"])).toHaveLength(3);
    expect(memory.list("app", ["chats", "ions"])[0]).toMatchObject({
      memoryId: "projects/app/tests-use-vitest.md",
      scope: "app",
      source: "c1",
    });
  });

  it("forgets a memory, and says so for one it doesn't know", () => {
    const path = memory.note("you", "x", "you");
    memory.forget(path, "you");
    expect(memory.list(null, ["chats", "ions"])).toEqual([]);
    expect(existsSync(join(dir, "memory", path))).toBe(false);
    expect(store.read({}).at(-1)).toMatchObject({
      type: EV.memoryForgotten,
      data: { path, by: "you", before: { text: "x" } },
    });
    expect(() => memory.forget("you/nope.md", "you")).toThrow(new UserError("Unknown memory: you/nope.md"));
    // CLI test, 2026-11-22: `ion memory forget nope` said "Not a memory file" instead.
    expect(() => memory.forget("nope", "you")).toThrow(new UserError("Unknown memory: nope"));
  });

  it("refuses an empty memory", () => {
    expect(() => memory.note("you", "  ", "you")).toThrow(UserError);
  });

  // Final review minor 7: a name that's already taken gets its own file, never overwriting another.
  it("never overwrites another memory with the same name", () => {
    const first = memory.note("you", "one", "you");
    const second = memory.note("you", "one", "you");
    expect([first, second]).toEqual(["you/one.md", "you/one-2.md"]);
    expect(memory.list(null, ["chats", "ions"]).map((m) => m.text)).toEqual(["one", "one"]);
  });
});
