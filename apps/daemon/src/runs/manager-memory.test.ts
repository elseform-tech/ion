import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, DEFAULT_CONFIG, saveUserConfig, setMemory, type UserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import { expect, it } from "vitest";
import { createGrants, type Grants } from "../mcp/index.js";
import type { Scope } from "../mcp/grants.js";
import { MemoryFiles } from "../memory/index.js";
import { NeedsService } from "../needs/index.js";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { chatsView } from "../views/chats.js";
import { RunManager } from "./manager.js";

process.env.ION_ALLOW_FAKE = "1";

/** A project "repo" with a fact of its own, your person file "Lisbon", and a run manager on the fake agent. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ion-run-memory-"));
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const who = ["-c", "user.email=t@example.com", "-c", "user.name=T"];
  execFileSync("git", ["-C", repo, ...who, "commit", "-q", "--allow-empty", "-m", "init"]);
  const configFile = join(dir, "config.toml");
  const base = addProject(DEFAULT_CONFIG, repo);
  saveUserConfig(configFile, base);
  const db = openDb(":memory:");
  const store = new EventStore(db, allViews);
  const memory = new MemoryFiles({ root: join(dir, "data", "memory"), store, db });
  const header = (name: string, type: "fact" | "person") => ({ name, description: name, type });
  memory.write({ scope: { projectId: "repo" }, header: header("Vitest", "fact"), text: "v", by: "you" });
  memory.write({ scope: "you", header: header("Lisbon", "person"), text: "l", by: "you" });
  // Each key a run is given, with what it may see.
  const scopes: Scope[] = [];
  const own = createGrants();
  const grants: Grants = { ...own, create: (s, k) => (scopes.push(s), own.create(s, k)) };
  const mcp = { grants, url: () => "http://127.0.0.1:9/mcp", memory };
  const ctx = { configFile, dataDir: join(dir, "data"), mcp };
  const runs = new RunManager(store, ctx, new NeedsService(store, db), db);
  const reply = async (text: string, more: { chatId?: string; noMemory?: boolean } = {}) => {
    const r = await runs.ask({ text, projectId: "repo", harness: "fake", ...more });
    for (let i = 0; i < 300 && !store.read({ runId: r.runId }).some((e) => e.type === EV.runFinished); i++)
      await new Promise((ok) => setTimeout(ok, 10));
    const said = store.read({ runId: r.runId }).find((e) => e.type === EV.messageCompleted);
    const scope = scopes.findLast((s) => s.kind === "run" && s.runId === r.runId);
    return { chatId: r.chatId, text: (said?.data as { text: string } | undefined)?.text ?? "", scope };
  };
  const set = (f: (c: UserConfig) => UserConfig) => saveUserConfig(configFile, f(base));
  return { reply, set, store, db, memory, dir };
}

/** What a run sees of memory: its first message's index, its instructions, and what its key opens. */
async function seen(s: ReturnType<typeof setup>, more: { chatId?: string; noMemory?: boolean } = {}) {
  const first = await s.reply("echo hi", more);
  const told = await s.reply("instructions", { chatId: first.chatId });
  return {
    first,
    told,
    index: first.text.includes("ion's memory index"),
    memory: told.text.includes("memory"),
  };
}

// The user, 2026-11-21: chats find memory through a quick index, and read the details on demand. A chat's first
// message starts with the files it may see (never your ions-only ones); a continued one doesn't repeat them.
it("starts a chat's first message with its memory index", async () => {
  const s = setup();
  const first = await s.reply("echo hi");
  expect(first.text).toMatch(
    /^<ion-data id="\w+" source="ion's memory index">\nprojects\/repo\/vitest.md "Vitest"/,
  );
  expect([first.text.includes("Lisbon"), first.text.endsWith("\n\necho hi")]).toEqual([false, true]);
  expect((await s.reply("echo again", { chatId: first.chatId })).text).toBe("echo again");
});

// The user, 2026-11-23: memory off: no tools, no list, nothing written. A chat's agent gets no memory index, no word
// of memory in its instructions, and a key that opens no memory tools.
it("memory off: no tools, no list, nothing written", async () => {
  const s = setup();
  s.set((c) => setMemory(c, false));
  const r = await seen(s);
  expect([r.index, r.memory]).toEqual([false, false]);
  expect(r.first.text).toBe("echo hi");
  expect(r.first.scope).toMatchObject({ memory: "none" });
});

// The user, 2026-11-23: per project off hides your personal memory from that project too.
it("per project off hides your personal memory from that project too", async () => {
  const s = setup();
  s.set((c) => setMemory(c, false, "repo"));
  const r = await seen(s);
  expect([r.index, r.memory, r.first.text.includes("Vitest")]).toEqual([false, false, false]);
  expect(r.first.scope).toMatchObject({ memory: "none" });
  // Everywhere off and this project on: its own files only, never yours.
  s.set((c) => setMemory(setMemory(c, false), true, "repo"));
  const p = await seen(s);
  expect([p.index, p.memory, p.first.text.includes("Vitest")]).toEqual([true, true, true]);
  expect(p.first.scope).toMatchObject({ memory: "project" });
});

// The user, 2026-11-23: a not-remembered chat gets no memory ("Don't remember", `ion ask --no-memory`), shown once in
// the chat, and for every later message of that chat; other chats keep theirs.
it("a not-remembered chat gets no memory", async () => {
  const s = setup();
  const r = await seen(s, { noMemory: true });
  expect([r.index, r.memory]).toEqual([false, false]);
  expect(r.first.scope).toMatchObject({ memory: "none" });
  expect(r.told.scope).toMatchObject({ memory: "none" });
  const lines = s.store.read({ chatId: r.first.chatId, types: [EV.chatMemory] });
  expect(lines.map((e) => e.data)).toEqual([{ on: false }]);
  expect(chatsView.list(s.db).find((c) => c.chatId === r.first.chatId)?.notRemembered).toBe(true);
  expect((await seen(s)).index).toBe(true);
});

// The user, 2026-11-23: turning it back on brings everything back: nothing was lost while it was off.
it("turning it back on brings everything back", async () => {
  const s = setup();
  const before = readFileSync(join(s.dir, "data", "memory", "projects", "repo", "vitest.md"), "utf8");
  s.set((c) => setMemory(c, false));
  expect((await seen(s)).index).toBe(false);
  s.set((c) => setMemory(c, true));
  const r = await seen(s);
  expect([r.index, r.memory, r.first.text.includes("Vitest")]).toEqual([true, true, true]);
  expect(r.first.scope).not.toHaveProperty("memory");
  expect(readFileSync(join(s.dir, "data", "memory", "projects", "repo", "vitest.md"), "utf8")).toBe(before);
});
