import { EV, type HarnessInfo, type NewEvent } from "@ion/schema";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { expect, it } from "vitest";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { handoffTargets, limitChoice, readyForLimit, yourAgent } from "./answers.js";
import { HarnessInfos } from "./harness-infos.js";

const info = (id: string): HarnessInfo => ({
  id,
  label: id,
  installed: true,
  signedIn: true,
  models: [],
  defaultModel: null,
});

// Coordinator, 2026-11-23: right after ion started, the limit question skipped an agent whose first sign-in check was
// still going (opencode's took over 5 s while every agent was checked at once), and offered the next one. It waits
// for that check, 8 s at most.
it("the limit question waits for an agent's first sign-in check, a few seconds at most", async () => {
  const slow = new HarnessInfos(["opencode", "grok-build"], async (id) => {
    if (id === "opencode") await new Promise((r) => setTimeout(r, 6000));
    return info(id);
  });
  slow.warm();
  expect(await readyForLimit(slow)).toEqual(["opencode", "grok-build"]);
  const stuck = new HarnessInfos(["opencode", "grok-build"], (id) =>
    id === "opencode" ? new Promise<HarnessInfo>(() => {}) : Promise.resolve(info(id)),
  );
  const t0 = Date.now();
  expect(await readyForLimit(stuck)).toEqual(["grok-build"]);
  expect(Date.now() - t0).toBeLessThan(9000);
}, 15_000);

// The user, 2026-11-24: "When an agent hits its limit" left Settings. Your own chats ask you; chats ions start go on
// the next ready agent by themselves (unattended, on Auto).
it("asks you at a limit in your chats, and goes on in chats ions start", () => {
  const db = openDb(":memory:");
  const store = new EventStore(db, allViews);
  const chat = (chatId: string, by?: "ion") =>
    store.append({
      chatId,
      runId: null,
      origin: "daemon",
      type: EV.chatCreated,
      data: { title: "t", projectId: "default", ...(by ? { by } : {}) },
    } as NewEvent);
  chat("mine");
  chat("ions", "ion");
  expect(limitChoice(db, "mine")).toBe("ask");
  expect(limitChoice(db, "ions")).toBe("continue");
});

// Security scan, 2026-11-24 (MEDIUM): a handoff in a chat ions start could land on an agent you marked "Avoid unless
// I ask". Avoided agents aren't handoff targets; with only those left, ion asks you.
it("never hands a chat to an agent you avoid", () => {
  const configFile = join(mkdtempSync(join(tmpdir(), "ion-answers-")), "config.toml");
  saveUserConfig(configFile, { ...DEFAULT_CONFIG, agents: { "grok-build": { avoid: true } } });
  expect(handoffTargets(configFile, ["grok-build", "codex", "opencode"])).toEqual(["opencode", "codex"]);
  expect(handoffTargets(configFile, ["grok-build"])).toEqual([]);
});

// PR #36 final review, 2026-11-24: a message of yours sent with no agent picked never goes on one you avoid; with
// only those ready, it says what to do.
it("never sends your chat to an agent you avoid", () => {
  const configFile = join(mkdtempSync(join(tmpdir(), "ion-answers-")), "config.toml");
  saveUserConfig(configFile, { ...DEFAULT_CONFIG, agents: { "grok-build": { avoid: true } } });
  expect(yourAgent(configFile, ["grok-build", "codex"], null)).toBe("codex");
  expect(() => yourAgent(configFile, ["grok-build"], null)).toThrow(
    "Every agent that's ready is marked Avoid: pick one in the message box, or turn Avoid off in Settings → Agents",
  );
});

// The user, 2026-11-28: "keep chat on its agent". Avoid covers what ion picks, not a chat you started: it stays on
// its agent for follow-ups after you set that agent to Avoid. A chat an ion started (own = null) still avoids it.
it("your chat stays on its agent after you set that agent to Avoid", () => {
  const configFile = join(mkdtempSync(join(tmpdir(), "ion-answers-")), "config.toml");
  saveUserConfig(configFile, { ...DEFAULT_CONFIG, agents: { "grok-build": { avoid: true } } });
  expect(yourAgent(configFile, ["grok-build", "codex"], "grok-build")).toBe("grok-build");
  // Not ready: it moves, and never onto an avoided one.
  expect(yourAgent(configFile, ["codex"], "grok-build")).toBe("codex");
});

it("a chat an ion started still avoids it", () => {
  const configFile = join(mkdtempSync(join(tmpdir(), "ion-answers-")), "config.toml");
  saveUserConfig(configFile, { ...DEFAULT_CONFIG, agents: { "grok-build": { avoid: true } } });
  expect(yourAgent(configFile, ["grok-build", "codex"], null)).toBe("codex");
  expect(handoffTargets(configFile, ["grok-build", "codex"])).toEqual(["codex"]);
});
