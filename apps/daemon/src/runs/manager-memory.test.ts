import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import { expect, it } from "vitest";
import { createGrants } from "../mcp/index.js";
import { MemoryFiles } from "../memory/index.js";
import { NeedsService } from "../needs/index.js";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { RunManager } from "./manager.js";

process.env.ION_ALLOW_FAKE = "1";

// The user, 2026-11-21: chats find memory through a quick index, and read the details on demand. A chat's first
// message starts with the files it may see (never your ions-only ones); a continued one doesn't repeat them.
it("starts a chat's first message with its memory index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ion-run-memory-"));
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const who = ["-c", "user.email=t@example.com", "-c", "user.name=T"];
  execFileSync("git", ["-C", repo, ...who, "commit", "-q", "--allow-empty", "-m", "init"]);
  const configFile = join(dir, "config.toml");
  saveUserConfig(configFile, addProject(DEFAULT_CONFIG, repo));
  const db = openDb(":memory:");
  const store = new EventStore(db, allViews);
  const memory = new MemoryFiles({ root: join(dir, "data", "memory"), store, db });
  const header = (name: string, type: "fact" | "person") => ({ name, description: name, type });
  memory.write({ scope: { projectId: "repo" }, header: header("Vitest", "fact"), text: "v", by: "you" });
  memory.write({ scope: "you", header: header("Lisbon", "person"), text: "l", by: "you" });
  const mcp = { grants: createGrants(), url: () => "http://127.0.0.1:9/mcp", memory };
  const ctx = { configFile, dataDir: join(dir, "data"), mcp };
  const runs = new RunManager(store, ctx, new NeedsService(store, db), db);
  const reply = async (text: string, chatId?: string) => {
    const r = await runs.ask({ text, projectId: "repo", harness: "fake", ...(chatId ? { chatId } : {}) });
    for (let i = 0; i < 300 && !store.read({ runId: r.runId }).some((e) => e.type === EV.runFinished); i++)
      await new Promise((ok) => setTimeout(ok, 10));
    const said = store.read({ runId: r.runId }).find((e) => e.type === EV.messageCompleted);
    return { chatId: r.chatId, text: (said?.data as { text: string } | undefined)?.text ?? "" };
  };
  const first = await reply("echo hi");
  expect(first.text).toMatch(
    /^<ion-data id="\w+" source="ion's memory index">\nprojects\/repo\/vitest.md "Vitest"/,
  );
  expect([first.text.includes("Lisbon"), first.text.endsWith("\n\necho hi")]).toEqual([false, true]);
  expect((await reply("echo again", first.chatId)).text).toBe("echo again");
});
