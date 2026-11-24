import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig, type UserConfig } from "@ion/config";
import { clockOf, type HarnessInfo, type NewEvent } from "@ion/schema";
import { describe, expect, it, vi } from "vitest";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { brainModel, getHarness } from "../adapters/registry.js";
import { allLimited, chatsPick, ionBrain, nextBrain, projectAgent, strongestBrain } from "./brain.js";

// Task review, 2026-11-21: picking an ion's agent asked every agent's CLI whether it was ready (slow, and under a full
// test run past a test's wait), even when the agent was already chosen. Only the chosen one is checked; every agent
// only when ion has to pick the first ready one.
/** A database with ion's views (the usage view marks limited agents). */
const viewsDb = () => {
  const db = openDb(":memory:");
  new EventStore(db, allViews).rebuildViews();
  return db;
};

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
      db: viewsDb(),
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
        db: viewsDb(),
        agents: async () => [info("fake", true), info("opencode", true)],
      };
      expect(await ionBrain(both, "_dream")).toMatchObject({ harness: "opencode" });
      const alone = { ...both, agents: async () => [info("fake", true)] };
      expect(await ionBrain(alone, "_dream")).toMatchObject({ harness: "fake" });
    } finally {
      delete process.env.ION_FAKE_HAS_WEB;
    }
  });

  // The user, 2026-11-23: "Orchestrator brain should be a better brain than the worker thread model" and, for a fresh
  // ion, "the strongest model you're signed in to". ion chief and a project ion with no agent of its own think on the
  // strongest model among the agents signed in and not limited (each adapter ranks its own), at High effort; a limited
  // one gives way to the next strongest, said once in the log. Your agent order is for workers and the judge, and
  // Dream still follows it.
  it("thinks on the strongest model you're signed in to, at High, past a limited one", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    const configFile = join(mkdtempSync(join(tmpdir(), "ion-brain-")), "config.toml");
    const projects = [{ id: "app", path: "/x/app", starred: false }];
    saveUserConfig(configFile, { ...DEFAULT_CONFIG, projects, memory: { dream: "nightly" } });
    const all = ["opencode", "grok-build", "codex", "claude-code"];
    const top = brainModel;
    const logged: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((l: string) => void logged.push(l));
    try {
      const d = (ids: string[], db = viewsDb()) => ({
        configFile,
        db,
        agents: async () => ids.map((id) => info(id, true)),
      });
      expect(await ionBrain(d(all), "chief")).toEqual({
        harness: "claude-code",
        model: top("claude-code"),
        effort: "high",
      });
      expect(await ionBrain(d(all), "app")).toMatchObject({ harness: "claude-code", effort: "high" });
      // Claude Code limited: Codex, the next strongest, said once.
      const db = viewsDb();
      const store = new EventStore(db, allViews);
      const limit = { resetsAt: new Date(Date.now() + 3600_000).toISOString() };
      const data = { code: "usage_limit", retryable: false, message: "x", limit, harness: "claude-code" };
      store.append({ chatId: null, runId: "turn_1", origin: "adapter", type: "error", data } as NewEvent);
      expect(await ionBrain(d(all, db), "chief")).toMatchObject({ harness: "codex", model: top("codex") });
      await ionBrain(d(all, db), "chief");
      expect(logged.filter((l) => l.includes("ion's brain"))).toEqual([
        "ion's brain: Claude Code is limited; it thinks on Codex",
      ]);
      // A turn that failed goes on the next strongest.
      expect(await nextBrain(d(all), "chief", ["claude-code"])).toMatchObject({
        harness: "codex",
        effort: "high",
      });
    } finally {
      warn.mockRestore();
    }
  });

  // The user, 2026-11-23: Settings names the strongest model you have, even while you've picked another.
  it("names the strongest model you have, with your effort or High", async () => {
    const configFile = join(mkdtempSync(join(tmpdir(), "ion-brain-")), "config.toml");
    saveUserConfig(configFile, { ...DEFAULT_CONFIG, ion: { ...DEFAULT_CONFIG.ion, quick: "grok-build" } });
    const d = {
      configFile,
      db: viewsDb(),
      agents: async () => [info("grok-build", true), info("codex", true)],
    };
    expect(await strongestBrain(d)).toEqual({
      agent: "codex",
      model: getHarness("codex")!.adapter.brain!.model,
      effort: "high",
    });
    expect(await strongestBrain({ ...d, agents: async () => [] })).toBeNull();
  });

  it("keeps the agent, model and effort you picked for ion", async () => {
    const configFile = join(mkdtempSync(join(tmpdir(), "ion-brain-")), "config.toml");
    saveUserConfig(configFile, {
      ...DEFAULT_CONFIG,
      ion: { ...DEFAULT_CONFIG.ion, quick: "grok-build:grok-4.6", quickEffort: "low" },
    });
    const d = {
      configFile,
      db: viewsDb(),
      agents: async () => [info("grok-build", true), info("claude-code", true)],
    };
    expect(await ionBrain(d, "chief")).toEqual({ harness: "grok-build", model: "grok-4.6", effort: "low" });
  });

  // Plan 19's checks, 2026-11-22: an ion whose agent wasn't ready had no agent at all ("I couldn't reach my agent").
  // It takes the next one: the user, 2026-11-23, the next strongest, at its strongest model and High.
  it("ion's agent that isn't ready gives way to the next strongest", async () => {
    const configFile = join(mkdtempSync(join(tmpdir(), "ion-brain-")), "config.toml");
    saveUserConfig(configFile, {
      ...DEFAULT_CONFIG,
      ion: { ...DEFAULT_CONFIG.ion, quick: "claude-code:opus" },
    });
    const d = {
      configFile,
      db: viewsDb(),
      agents: async () => [info("claude-code", false), info("opencode", false), info("grok-build", true)],
    };
    expect(await ionBrain(d, "chief")).toEqual({
      harness: "grok-build",
      model: brainModel("grok-build"),
      effort: "high",
    });
  });

  // PR #36 re-review, the user, 2026-11-23: a project's agent, model and effort are for the chats its ion starts
  // (workers); the project's ion itself thinks with ion's brain: your pick in Settings → Ions, else the strongest. A
  // project model with no agent never reaches the brain.
  it("a project's ion thinks with ion's brain, not the project's agent", async () => {
    const configFile = join(mkdtempSync(join(tmpdir(), "ion-brain-")), "config.toml");
    const projects = [
      {
        id: "app",
        path: "/x/app",
        starred: false,
        harness: "grok-build",
        model: "grok-4.6",
        effort: "low" as const,
      },
      { id: "web", path: "/x/web", starred: false, model: "opus" },
    ];
    saveUserConfig(configFile, { ...DEFAULT_CONFIG, projects });
    const d = {
      configFile,
      db: viewsDb(),
      agents: async () => [info("grok-build", true), info("codex", true)],
    };
    const strongest = { harness: "codex", model: brainModel("codex"), effort: "high" };
    expect(await ionBrain(d, "app")).toEqual(strongest);
    expect(await ionBrain(d, "web")).toEqual(strongest);
    saveUserConfig(configFile, {
      ...DEFAULT_CONFIG,
      projects,
      ion: { ...DEFAULT_CONFIG.ion, quick: "grok-build:grok-4.7", quickEffort: "max" },
    });
    expect(await ionBrain(d, "app")).toEqual({ harness: "grok-build", model: "grok-4.7", effort: "max" });
  });

  // PR #36 re-review, the user, 2026-11-23: High for your messages to an ion; Medium for routine turns nobody asked
  // for (a project ion's report when its chat ends); an effort you set applies to your messages, and routine turns
  // take the lower of yours and Medium.
  it("thinks at Medium on routine turns, never above your effort", async () => {
    const configFile = join(mkdtempSync(join(tmpdir(), "ion-brain-")), "config.toml");
    const d = { configFile, db: viewsDb(), agents: async () => [info("grok-build", true)] };
    saveUserConfig(configFile, DEFAULT_CONFIG);
    expect(await ionBrain(d, "chief")).toMatchObject({ effort: "high" });
    expect(await ionBrain(d, "chief", { routine: true })).toMatchObject({ effort: "medium" });
    for (const [mine, routine] of [
      ["low", "low"],
      ["max", "medium"],
    ] as const) {
      saveUserConfig(configFile, { ...DEFAULT_CONFIG, ion: { ...DEFAULT_CONFIG.ion, quickEffort: mine } });
      expect(await ionBrain(d, "app", { routine: true })).toMatchObject({ effort: routine });
      expect(await ionBrain(d, "app")).toMatchObject({ effort: mine });
    }
  });

  // The user, 2026-11-24 ("yes, please"): Dream thinks with ions' brain (your pick, else the strongest) at Medium, on
  // an agent that can turn its web off: when the brain's can't, the next strongest that can, said once in the log. An
  // explicit [memory] dreamAgent from an older config still wins.
  it("dreams with ion's brain at Medium, on an agent that can turn its web off", async () => {
    process.env.ION_ALLOW_FAKE = "1";
    const configFile = join(mkdtempSync(join(tmpdir(), "ion-brain-")), "config.toml");
    saveUserConfig(configFile, { ...DEFAULT_CONFIG, memory: { dream: "nightly" } });
    const d = (ids: string[]) => ({
      configFile,
      db: viewsDb(),
      agents: async () => ids.map((id) => info(id, true)),
    });
    expect(await ionBrain(d(["opencode", "codex"]), "_dream")).toEqual({
      harness: "codex",
      model: brainModel("codex"),
      effort: "medium",
    });
    saveUserConfig(configFile, {
      ...DEFAULT_CONFIG,
      ion: { ...DEFAULT_CONFIG.ion, quick: "fake", quickEffort: "low" },
      memory: { dream: "nightly" },
    });
    const logged: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((l: string) => void logged.push(l));
    process.env.ION_FAKE_HAS_WEB = "1";
    try {
      expect(await ionBrain(d(["fake", "opencode"]), "_dream")).toMatchObject({
        harness: "opencode",
        effort: "low",
      });
      await ionBrain(d(["fake", "opencode"]), "_dream");
      expect(logged).toEqual(["ion's dream: Fake can't turn its web off; it dreams on opencode"]);
    } finally {
      delete process.env.ION_FAKE_HAS_WEB;
      warn.mockRestore();
    }
    saveUserConfig(configFile, { ...DEFAULT_CONFIG, memory: { dream: "nightly", dreamAgent: "opencode" } });
    expect(await ionBrain(d(["opencode", "codex"]), "_dream")).toMatchObject({ harness: "opencode" });
  });

  // The user, 2026-11-22: an agent marked limited (by any chat's run or ion's turn) is skipped like one that isn't
  // ready, and the turn knows which it skipped (its reply says why in one line).
  it("a limited agent is skipped", async () => {
    const configFile = join(mkdtempSync(join(tmpdir(), "ion-brain-")), "config.toml");
    saveUserConfig(configFile, { ...DEFAULT_CONFIG, ion: { ...DEFAULT_CONFIG.ion, quick: "claude-code" } });
    const db = openDb(":memory:");
    const store = new EventStore(db, allViews);
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    const data = {
      code: "usage_limit",
      retryable: false,
      message: "x",
      limit: { resetsAt },
      harness: "claude-code",
    };
    store.append({ chatId: null, runId: "turn_1", origin: "adapter", type: "error", data } as NewEvent);
    const d = {
      configFile,
      db,
      agents: async () => [info("claude-code", true), info("grok-build", true)],
    };
    expect(await ionBrain(d, "chief")).toEqual({
      harness: "grok-build",
      model: brainModel("grok-build"),
      effort: "high",
      skipped: ["claude-code"],
    });
  });

  // Review, 2026-11-22: with every agent limited an ion said only "I couldn't reach my agent". An agent whose mark is
  // only ion's guess (its limit named no reset) is tried anyway, one turn; with only stated resets left, the ion has no
  // agent and says which frees up first: "<Agent> is limited until 16:00". The same for ion chief, a project's ion and
  // the dream.
  describe("all agents limited", () => {
    const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
    const setup = (marks: Record<string, string | null>) => {
      const configFile = join(mkdtempSync(join(tmpdir(), "ion-brain-")), "config.toml");
      const projects = [{ id: "app", path: "/x/app", starred: false, harness: "grok-build" }];
      saveUserConfig(configFile, {
        ...DEFAULT_CONFIG,
        ion: { ...DEFAULT_CONFIG.ion, quick: "grok-build" },
        memory: { dream: "nightly", dreamAgent: "grok-build" },
        projects,
      });
      const db = viewsDb();
      const store = new EventStore(db, allViews);
      for (const [harness, resetsAt] of Object.entries(marks)) {
        const limit = resetsAt ? { resetsAt } : {};
        const data = { code: "usage_limit", retryable: false, message: "x", limit, harness };
        store.append({ chatId: null, runId: null, origin: "adapter", type: "error", data } as NewEvent);
      }
      const ids = Object.keys(marks);
      return { configFile, db, agents: async () => ids.map((id) => info(id, true)) };
    };

    it("an agent limited by ion's guess only is tried anyway", async () => {
      const d = setup({ "grok-build": at(2), opencode: null });
      for (const ionId of ["chief", "app", "_dream"])
        expect(await ionBrain(d, ionId)).toMatchObject({ harness: "opencode" });
    });

    it("with only stated resets, no agent, and the earliest reset said", async () => {
      const d = setup({ "grok-build": at(3), opencode: at(1) });
      for (const ionId of ["chief", "app", "_dream"]) expect(await ionBrain(d, ionId)).toBeNull();
      const clock = clockOf(at(1), new Date());
      expect(await allLimited(d)).toBe(`opencode is limited until ${clock}`);
      expect(await allLimited(setup({ "grok-build": at(3), opencode: null }))).toBeNull();
    });
  });
});

// The user, 2026-11-24: what a chat an ion starts runs on, when one is set: what you asked for that chat (through the
// ion), else the project's own (its page → More), else "Chats ions start run on"; none: Automatic picks.
describe("what chats ions start run on", () => {
  const c = (more: Partial<UserConfig> = {}): UserConfig => ({
    ...DEFAULT_CONFIG,
    projects: [
      { id: "web", path: "/w", starred: false, harness: "codex", model: "gpt-5.6-sol", effort: "low" },
      { id: "app", path: "/a", starred: false },
    ],
    ...more,
  });
  it("takes what you asked, else the project's own, else the setting, else Automatic", () => {
    const set = c({ ion: { ...DEFAULT_CONFIG.ion, chats: "grok-build:grok-4.7", chatsEffort: "medium" } });
    expect(chatsPick(set, "web", { harness: "opencode" })).toEqual({ harness: "opencode" });
    expect(chatsPick(set, "web")).toEqual({ harness: "codex", model: "gpt-5.6-sol", effort: "low" });
    expect(chatsPick(set, "app")).toEqual({ harness: "grok-build", model: "grok-4.7", effort: "medium" });
    expect(chatsPick(c(), "app")).toEqual({});
  });
});

// PR #36 final review, 2026-11-24: an agent you marked "Avoid unless I ask" is never picked without your click, also
// where Automatic finds nothing (a project's last agent, the first ready one).
describe("an avoided agent", () => {
  const info = (id: string, ready: boolean): HarnessInfo => ({
    ...{ id, label: id, installed: ready, signedIn: ready, models: [], defaultModel: null },
  });
  it("isn't a project's agent unless the project names it", async () => {
    const configFile = join(mkdtempSync(join(tmpdir(), "ion-brain-")), "config.toml");
    const avoid = { agents: { "grok-build": { avoid: true } } };
    saveUserConfig(configFile, {
      ...DEFAULT_CONFIG,
      ...avoid,
      projects: [{ id: "app", path: "/a", starred: false }],
    });
    const db = viewsDb();
    const d = (ids: string[]) => ({ configFile, db, agents: async () => ids.map((id) => info(id, true)) });
    expect(await projectAgent(d(["grok-build", "codex"]), "app")).toBe("codex");
    expect(await projectAgent(d(["grok-build"]), "app")).toBeUndefined();
  });
});
