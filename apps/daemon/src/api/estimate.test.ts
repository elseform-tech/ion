import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import type { HarnessInfo, NewEvent } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { estimateFor } from "./estimate.js";

const info = (id: string): HarnessInfo => ({
  ...{ id, label: id, installed: true, signedIn: true, models: [], defaultModel: null },
});

/** Five past chats in `default` on this agent, each a short change that took `tokens` in all. */
function past(store: EventStore, harness: string, tokens: number) {
  for (let i = 0; i < 5; i++) {
    const [chatId, runId] = [`${harness}-c${i}`, `${harness}-r${i}`];
    const add = (type: string, data: object, run: string | null, origin = "daemon") =>
      store.append({ chatId, runId: run, origin, type, data } as NewEvent);
    add("chat.created", { title: "t", projectId: "default" }, null);
    add("message.sent", { text: "Add a line to notes.md" }, null);
    add("run.started", { harness, model: "m", effort: null, authMethod: null }, runId, "adapter");
    const used = { model: "m", inputTokens: tokens - 10, outputTokens: 10, totalTokens: tokens };
    add("usage.reported", used, runId, "adapter");
    add("run.finished", { status: "done" }, runId);
  }
}

// Brain-avoid fix review, 2026-11-28: with Automatic finding no free agent, the brain pill's hover estimated the
// request on the first ready agent in your order even when you set it to Avoid, while the message itself goes on the
// first one you don't avoid. The estimate names the agent the message will go on.
describe("the estimate before you send", () => {
  it("is for the agent the message goes on, never one you avoid", async () => {
    const configFile = join(mkdtempSync(join(tmpdir(), "ion-estimate-")), "config.toml");
    saveUserConfig(configFile, {
      ...DEFAULT_CONFIG,
      agents: { "claude-code": { avoid: true } },
      routing: { ...DEFAULT_CONFIG.routing, order: ["claude-code", "opencode"] },
    });
    const db = openDb(":memory:");
    const store = new EventStore(db, allViews);
    store.rebuildViews();
    past(store, "opencode", 1000);
    past(store, "claude-code", 9000);
    // opencode limited: Automatic finds no free agent, and ion's usual default applies.
    const limit = { resetsAt: new Date(Date.now() + 3600_000).toISOString() };
    const data = { code: "usage_limit", retryable: false, message: "x", limit, harness: "opencode" };
    store.append({ chatId: null, runId: null, origin: "adapter", type: "error", data } as NewEvent);
    const e = await estimateFor({ db, configFile }, { text: "Add a line to notes.md" }, [
      info("claude-code"),
      info("opencode"),
    ]);
    expect(e).toMatchObject({ unit: "tokens", high: 1000 });
  });
});
