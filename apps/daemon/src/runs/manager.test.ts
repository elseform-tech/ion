import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import type { IonEvent } from "@ion/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { UserError } from "../api/errors.js";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { RunManager } from "./manager.js";

process.env.ION_ALLOW_FAKE = "1";

let store: EventStore;
let runs: RunManager;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ion-runs-"));
  const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const configFile = join(home, "config.toml");
  saveUserConfig(configFile, addProject(DEFAULT_CONFIG, repo));
  store = new EventStore(openDb(":memory:"), allViews);
  runs = new RunManager(store, { configFile });
});

async function finished(runId: string, ms = 3000): Promise<IonEvent[]> {
  const end = Date.now() + ms;
  for (;;) {
    const events = store.read({ runId });
    if (events.some((e) => e.type === "run.finished")) return events;
    if (Date.now() > end) throw new Error("run didn't finish");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ask = (text: string, extra: object = {}) =>
  runs.ask({ text, projectId: "repo", harness: "fake", ...extra });

describe("RunManager", () => {
  it("creates a chat and stores the run's events in order", async () => {
    const { chatId, runId } = await ask("hello");
    const types = (await finished(runId)).map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types.at(-1)).toBe("run.finished");
    expect(store.read({ chatId })[0]?.type).toBe("chat.created");
    expect(store.read({ runId }).every((e) => e.origin === "adapter" || e.type === "approval.resolved")).toBe(
      true,
    );
  });

  it("denies edits by policy unless allowed, and records the decision after the request", async () => {
    const { runId } = await ask("approve");
    const events = await finished(runId);
    const types = events.map((e) => e.type);
    expect(types.indexOf("approval.requested")).toBeLessThan(types.indexOf("approval.resolved"));
    expect(events.find((e) => e.type === "approval.resolved")).toMatchObject({
      origin: "daemon",
      data: { decision: "deny", by: "policy" },
    });
    expect(types).not.toContain("file.changed");
  });

  it("allows edits inside the project with allowEdits", async () => {
    const { runId } = await ask("approve", { allowEdits: true });
    const events = await finished(runId);
    expect(events.find((e) => e.type === "approval.resolved")?.data).toMatchObject({ decision: "allow" });
    expect(events.map((e) => e.type)).toContain("file.changed");
  });

  it("stores a failed run and keeps working", async () => {
    const { runId } = await ask("fail");
    expect((await finished(runId)).at(-1)?.data).toEqual({ status: "failed" });
    const again = await ask("hello");
    expect((await finished(again.runId)).at(-1)?.data).toEqual({ status: "done" });
  });

  it("refuses a second run in a chat that's still running", async () => {
    const { chatId, runId } = await ask("slow");
    await expect(ask("hello", { chatId })).rejects.toThrow("This chat is already running");
    await runs.interrupt(runId);
    expect((await finished(runId)).at(-1)?.data).toEqual({ status: "interrupted" });
  });

  it("interrupts within a second", async () => {
    const { runId } = await ask("slow");
    const t = Date.now();
    await runs.interrupt(runId);
    await finished(runId);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("rejects an unknown project or harness without storing anything", async () => {
    await expect(ask("hello", { projectId: "nope" })).rejects.toThrow(new UserError("Unknown project: nope"));
    await expect(ask("hello", { harness: "nope" })).rejects.toThrow("Unknown harness: nope");
    expect(store.read({})).toHaveLength(0);
  });
});
