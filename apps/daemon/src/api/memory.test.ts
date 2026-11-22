import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EV } from "@ion/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryFiles } from "../memory/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import type { Ctx } from "./commands.js";
import { memoryHandlers, todoHandlers } from "./memory.js";

const handlers = { ...memoryHandlers, ...todoHandlers };
type H = typeof handlers;

// The user, 2026-11-21: "use it as hybrid, sqlite for indexes and history (quick search) and memory for details".
// Settings → Memory reads each file's history, restores an older text, shares your files with chats, and says
// which files can't be read.
describe("memory in Settings", () => {
  let db: Db;
  let store: EventStore;
  let memory: MemoryFiles;
  let ctx: Ctx;
  const client = {
    call: async <K extends keyof H>(cmd: K, a: Parameters<H[K]>[0]) =>
      (handlers[cmd] as (a: unknown, c: Ctx) => ReturnType<H[K]>)(a, ctx),
  };

  beforeEach(() => {
    db = openDb(":memory:");
    store = new EventStore(db, allViews);
    const root = mkdtempSync(join(tmpdir(), "ion-mem-api-"));
    memory = new MemoryFiles({ root: join(root, "memory"), store, db });
    ctx = { db, store, memory, configFile: join(root, "config.toml") } as unknown as Ctx;
  });

  const read = async (name: string) => client.call("memory.read", { name });

  it("History restores an older text, as you, only over the version read", async () => {
    await client.call("todo.add", { text: "Renew the passport" });
    const path = "you/renew-the-passport.md";
    let f = await read(path);
    await client.call("memory.write", { path, text: "Renew the passport before March", expect: f.hash });
    f = await read(path);
    const history = await client.call("memory.history", { path });
    // Newest first, each with who and the text it left.
    expect(history.map((h) => [h.kind, h.source, h.text])).toEqual([
      ["written", "you", "Renew the passport before March"],
      ["written", "you", "Renew the passport"],
    ]);
    await client.call("memory.write", { path, text: history[1]!.text!, expect: f.hash });
    expect((await read(path)).text).toBe("Renew the passport");
    // A stale version is refused.
    await expect(client.call("memory.write", { path, text: "x", expect: f.hash })).rejects.toThrow(
      "Changed since you read it",
    );
  });

  it("Shared with chats changes see; a chat's change says the chat's title", async () => {
    const r = await client.call("todo.add", { text: "Call the dentist" });
    const f = await read(r.memoryId);
    await client.call("memory.write", { path: f.path, see: "chats", expect: f.hash });
    expect((await read(f.path)).see).toBe("chats");
    store.append({
      chatId: "c1",
      runId: null,
      origin: "daemon",
      type: EV.chatCreated,
      data: { title: "Docs pass", projectId: "app" },
    });
    memory.write({
      scope: "you",
      header: { name: "Tabs", description: "Tabs, not spaces", type: "preference" },
      text: "Tabs",
      by: { chatId: "c1", runId: "r1" },
    });
    const tabs = (await client.call("memory.list", {})).find((m) => m.name === "Tabs");
    expect(tabs).toMatchObject({ source: "c1", sourceTitle: "Docs pass" });
  });

  it("says which files can't be read", async () => {
    const { path } = await client.call("memory.folder", {});
    mkdirSync(join(path, "you"), { recursive: true });
    writeFileSync(join(path, "you", "broken.md"), "no header here");
    memory.reindex();
    expect((await client.call("memory.folder", {})).problems).toEqual(["you/broken.md can't be read"]);
  });

  // Task review, 2026-11-22: search took the top 20 of every scope, then the app kept the chosen scope's: a project's
  // match below 20 of yours showed nothing.
  it("searches one scope before it takes the best 20", async () => {
    for (let i = 0; i < 25; i++)
      memory.write({
        scope: "you",
        header: { name: `Deploy note ${i}`, description: "deploy deploy deploy", type: "fact" },
        text: "deploy deploy deploy",
        by: "you",
      });
    memory.write({
      scope: { projectId: "shop" },
      header: { name: "Shop", description: "how to deploy", type: "reference" },
      text: "Ship it with the script.",
      by: "you",
    });
    const found = await client.call("memory.search", { q: "deploy", scope: "shop" });
    expect(found.map((m) => m.name)).toEqual(["Shop"]);
    expect(await client.call("memory.search", { q: "deploy", scope: "you" })).toHaveLength(20);
  });
});
