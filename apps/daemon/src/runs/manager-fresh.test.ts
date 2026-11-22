import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import { afterEach, beforeEach, expect, it } from "vitest";
import { NeedsService } from "../needs/index.js";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { RunManager } from "./manager.js";

process.env.ION_ALLOW_FAKE = "1";

let store: EventStore;
let runs: RunManager;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ion-run-fresh-"));
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const who = ["-c", "user.email=t@example.com", "-c", "user.name=T"];
  execFileSync("git", ["-C", repo, ...who, "commit", "-q", "--allow-empty", "-m", "init"]);
  const configFile = join(dir, "config.toml");
  saveUserConfig(configFile, addProject(DEFAULT_CONFIG, repo));
  const db = openDb(":memory:");
  store = new EventStore(db, allViews);
  runs = new RunManager(store, { configFile, dataDir: join(dir, "data") }, new NeedsService(store, db), db);
});

afterEach(() => {
  delete process.env.ION_FAKE_RESUME_FAIL;
  delete process.env.ION_FAKE_CONTEXT_TOKENS;
});

/** Sends a message in the chat and waits for its run: what the agent was sent (the fake one echoes it). */
async function reply(text: string, chatId?: string) {
  const r = await runs.ask({ text, projectId: "repo", harness: "fake", ...(chatId ? { chatId } : {}) });
  for (let i = 0; i < 300 && !store.read({ runId: r.runId }).some((e) => e.type === EV.runFinished); i++)
    await new Promise((ok) => setTimeout(ok, 10));
  const said = store.read({ runId: r.runId }).find((e) => e.type === EV.messageCompleted);
  return { chatId: r.chatId, text: (said?.data as { text: string } | undefined)?.text ?? "" };
}

/** A chat of ten exchanges, each message about `size` characters (the fake agent says it back). */
async function chatOf(size: number): Promise<string> {
  const first = await reply(`echo m0 ${"a".repeat(size)}`);
  for (let i = 1; i < 10; i++) await reply(`echo m${i} ${"b".repeat(size)}`, first.chatId);
  return first.chatId;
}

const freshLines = (chatId: string) =>
  store.read({ chatId, types: [EV.chatHandoff] }).map((e) => (e.data as { text: string }).text);

// The user, 2026-11-22 ("sure"): a new session for a chat whose history is longer than the new agent can take
// (about half its window, characters/4) gets ion's brief and its last few messages, not the whole transcript; the
// chat shows "Started fresh with a summary" once.
it("a long chat starting fresh gets the brief and its last messages, not the whole transcript", async () => {
  process.env.ION_FAKE_CONTEXT_TOKENS = "2000"; // half of it: 1,000 tokens, about 4,000 characters
  const chatId = await chatOf(300); // about 6,000 characters
  process.env.ION_FAKE_RESUME_FAIL = "1";
  const got = (await reply("echo next", chatId)).text;
  expect(got).toMatch(/source="ion's summary of this chat"/);
  expect(got).toContain('Your request: "echo m0 a');
  expect(got).toContain("echo m9");
  expect(got).toContain("echo m8");
  expect(got).not.toContain("echo m3");
  expect(got).toContain("Check git status and the tests before continuing");
  expect(got.endsWith("\n\necho next")).toBe(true);
  expect(got.length).toBeLessThan(4000);
  expect(freshLines(chatId)).toEqual(["Started fresh with a summary"]);
});

// The user, 2026-11-22: short chats keep the full history as today. Short is within the agent's budget: 60,000
// characters fit in half of 128k tokens (before, the oldest were cut at 24,000 characters).
it("a short chat still gets its full history", async () => {
  const chatId = await chatOf(3000);
  process.env.ION_FAKE_RESUME_FAIL = "1";
  const got = (await reply("echo next", chatId)).text;
  expect(got).toMatch(/source="this chat's earlier messages"/);
  for (let i = 0; i < 10; i++) expect(got).toContain(`you: "echo m${i}`);
  expect(got).not.toContain("ion's summary");
  expect(freshLines(chatId)).toEqual([]);
});
