import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EV } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserError } from "../api/errors.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { memoryView } from "../views/memory.js";
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
      scope: "project:app",
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

  // Task review, 2026-11-22: a project with id "you" shared your scope: its files reached every chat, and removing
  // it forgot your own files.
  it("keeps a project called you apart from your own files", () => {
    memory.note("you", "Mine", "you");
    memory.note({ projectId: "you" }, "Theirs", "you");
    memory.note({ projectId: "app" }, "App's", "you");
    const both = ["chats", "ions"] as const;
    expect(memory.list("app", [...both]).map((m) => m.text)).toEqual(["Mine", "App's"]);
    expect(memory.list(["app"], [...both]).map((m) => m.text)).toEqual(["Mine", "App's"]);
    expect(memory.list("you", [...both]).map((m) => m.text)).toEqual(["Mine", "Theirs"]);
    const scopes = [{ projectId: "app" }, "you" as const];
    expect(memoryView.search(db, { scopes, see: [...both] }).map((r) => r.path)).not.toContain(
      "projects/you/theirs.md",
    );
    expect(memoryView.search(db, { scopes: [{ projectId: "you" }], see: [...both] })).toMatchObject([
      { path: "projects/you/theirs.md", scope: { projectId: "you" } },
    ]);
    // Task 1 re-review, 2026-11-22: the list showed a legacy folder called you as "you", like your own files.
    expect(memory.list("you", [...both]).map((m) => m.scope)).toEqual(["you", "project:you"]);
    memory.forgetProject("you", "you");
    expect(memory.list(null, [...both]).map((m) => m.text)).toEqual(["Mine", "App's"]);
  });

  // Task 1 re-review, 2026-11-22: removing a project forgot its first 1000 files only (search's default limit);
  // moving old notes may put more than that in one folder.
  it("forgets every file of a removed project, however many", () => {
    for (let i = 0; i < 1003; i++) memory.note({ projectId: "big" }, `note ${i}`, "you", { overCap: true });
    memory.forgetProject("big", "you");
    expect(memory.list("big", ["chats", "ions"])).toEqual([]);
  }, 60_000);

  // Task review, 2026-11-22: Task 2's tools forget a file only as it was read.
  it("forgets a file only as it was read, when asked to", () => {
    const path = memory.note("you", "x", "you");
    expect(() => memory.forget(path, "you", "stale")).toThrow(new UserError("Changed since you read it"));
    const r = memory.read(path);
    memory.forget(path, "you", r.ok ? r.file.hash : "");
    expect(memory.list(null, ["chats", "ions"])).toEqual([]);
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
