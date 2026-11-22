import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import type { HarnessInfo } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { openDb } from "../store/index.js";
import { ionBrain } from "./brain.js";

// Task review, 2026-11-21: picking an ion's agent asked every agent's CLI whether it was ready (slow, and under a full
// test run past a test's wait), even when the agent was already chosen. Only the chosen one is checked; every agent
// only when ion has to pick the first ready one.
describe("an ion's agent", () => {
  const info = (id: string, ready: boolean): HarnessInfo => ({
    ...{ id, label: id, installed: ready, signedIn: ready, models: [], defaultModel: null },
  });
  it("checks only the chosen agent", async () => {
    const configFile = join(mkdtempSync(join(tmpdir(), "ion-brain-")), "config.toml");
    const projects = [{ id: "app", path: "/x/app", starred: false, harness: "fake" }];
    saveUserConfig(configFile, {
      ...DEFAULT_CONFIG,
      ion: { ...DEFAULT_CONFIG.ion, quick: "fake" },
      projects,
    });
    const asked: string[] = [];
    const d = {
      configFile,
      db: openDb(":memory:"),
      agents: async () => {
        asked.push("all");
        return [info("fake", true), info("opencode", true)];
      },
      agent: async (id: string) => {
        asked.push(id);
        return info(id, true);
      },
    };
    expect(await ionBrain(d, "chief")).toMatchObject({ harness: "fake" });
    expect(await ionBrain(d, "app")).toMatchObject({ harness: "fake" });
    expect(asked).toEqual(["fake", "fake"]);
  });

  // Task review, 2026-11-22: a dream never searches the web. On an agent that can't turn its web off it moves to the
  // next ready one that can; with none, it keeps the chosen one, and the turn says it was skipped.
  it("picks a dream agent that can turn its web off", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    process.env.ION_FAKE_HAS_WEB = "1";
    try {
      const configFile = join(mkdtempSync(join(tmpdir(), "ion-brain-")), "config.toml");
      saveUserConfig(configFile, { ...DEFAULT_CONFIG, memory: { dream: "nightly", dreamAgent: "fake" } });
      const both = {
        configFile,
        db: openDb(":memory:"),
        agents: async () => [info("fake", true), info("claude-code", true)],
      };
      expect(await ionBrain(both, "_dream")).toMatchObject({ harness: "claude-code" });
      const alone = { ...both, agents: async () => [info("fake", true)] };
      expect(await ionBrain(alone, "_dream")).toMatchObject({ harness: "fake" });
    } finally {
      delete process.env.ION_FAKE_HAS_WEB;
    }
  });
});
