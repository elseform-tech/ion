// The only place the daemon loads harness adapters (lint: ion/walls).
import { createAcpAdapter, GROK_BUILD, OPENCODE, type ProbePlace } from "@ion/adapter-acp";
import { createClaudeCodeAdapter } from "@ion/adapter-claude-code";
import { createCodexAdapter } from "@ion/adapter-codex";
import { createFakeAdapter } from "@ion/adapter-fake";
import type { HarnessAdapter, PickStyle } from "@ion/adapter-kit";
import type { SkillWhose } from "@ion/schema";

/** An agent ion knows: its adapter, its name, and the commands that sign in and install it. */
export type HarnessEntry = { adapter: HarnessAdapter; label: string; loginHint: string; install?: string };

/**
 * The command that installs each agent (Plan 21: a beginner without one is told how), checked on npm 2026-11-23:
 * opencode-ai, @xai-official/grok (Grok Build's `grok`, the version ion runs), @openai/codex, @anthropic-ai/claude-code.
 */
const INSTALL: Record<string, string> = {
  opencode: "npm i -g opencode-ai",
  "grok-build": "npm i -g @xai-official/grok",
  codex: "npm i -g @openai/codex",
  "claude-code": "npm i -g @anthropic-ai/claude-code",
};

/** Where and how ion's checks of an agent open it; set once at the daemon's start (none: the temp folder, unsandboxed). */
let probePlace: ProbePlace = {};

/** Sets where ion's sign-in and model checks open an agent: ion's data folder, in the daemon's sandbox. */
export function placeProbes(p: ProbePlace): void {
  probePlace = p;
}

const probes = () => probePlace;

const ENTRIES: Record<string, () => HarnessEntry> = {
  "claude-code": () => ({
    adapter: createClaudeCodeAdapter(),
    label: "Claude Code",
    loginHint: "claude auth login",
  }),
  codex: () => ({ adapter: createCodexAdapter(), label: "Codex", loginHint: "codex login" }),
  "grok-build": () => ({
    adapter: createAcpAdapter(GROK_BUILD, { probes }),
    label: GROK_BUILD.label,
    loginHint: GROK_BUILD.loginHint,
  }),
  opencode: () => ({
    adapter: createAcpAdapter(OPENCODE, { probes }),
    label: OPENCODE.label,
    loginHint: OPENCODE.loginHint,
  }),
};

/** Every harness ion knows (the fake one only for tests). */
export function harnessIds(): string[] {
  return [...Object.keys(ENTRIES), ...(process.env.ION_ALLOW_FAKE === "1" ? ["fake"] : [])];
}

/** The agents the app lists: real ones only; the fake one too in debug mode (ION_DEBUG=1). */
export function listedHarnessIds(): string[] {
  return harnessIds().filter((id) => id !== "fake" || process.env.ION_DEBUG === "1");
}

/** A harness by id, or null. The fake harness exists only for tests (ION_ALLOW_FAKE=1; ION_FAKE_SIGNED_OUT=1). */
export function getHarness(id: string): HarnessEntry | null {
  if (id === "fake" && process.env.ION_ALLOW_FAKE === "1")
    return {
      adapter: createFakeAdapter(),
      label: "Fake",
      loginHint: "ion fake login",
    };
  const made = ENTRIES[id]?.();
  const e = made ? { ...made, install: INSTALL[id] } : null;
  return e && realAgentsOff() ? { ...e, adapter: { ...e.adapter, start: refuseInTests } } : e;
}

/**
 * Under tests (VITEST) without a live flag (ION_LIVE, ION_LIVE_GROK, ION_LIVE_CLAUDE, ION_LIVE_CODEX), no real agent
 * starts a session (pnpm check, 2026-11-22: a test's judge fell back to claude-code:haiku and called it; AGENTS.md: no
 * real model calls in tests).
 */
const realAgentsOff = () =>
  !!process.env.VITEST &&
  !Object.keys(process.env).some((k) => /^ION_LIVE(_\w+)?$/.test(k) && process.env[k] === "1");

const refuseInTests = (): never => {
  throw new Error("real agents are off in tests");
};

/** ion's own agent order, when you set none (quota-friendly first). */
const PREFERRED = ["opencode", "grok-build", "codex", "claude-code"];

/**
 * Your agent order (Settings → Agents; the user, 2026-11-22): the agents you put in order (ones ion knows), then the
 * rest in ion's own order.
 */
export function agentOrder(saved: string[]): string[] {
  const known = new Set([...PREFERRED, ...harnessIds()]);
  const yours = [...new Set(saved)].filter((id) => known.has(id));
  return [...yours, ...PREFERRED.filter((id) => !yours.includes(id))];
}

/** The agent to use when none is named: the chat's own while it's ready, else the first ready in your order. */
export function defaultAgent(ready: string[], own: string | null, order = PREFERRED): string | undefined {
  if (own && ready.includes(own)) return own;
  return order.find((id) => ready.includes(id)) ?? ready[0];
}

/** These agents best first: in your order, then the rest as given. */
export const byPreference = (ids: string[], order = PREFERRED): string[] => [
  ...order.filter((id) => ids.includes(id)),
  ...ids.filter((id) => !order.includes(id)),
];

/** The agent ion saves (the user's standing rule): never one ion's own model moves to unasked. */
const SAVED = "claude-code";

/** Whether ion's own model may go on this agent: any, but Claude Code only first in your order or alone ready. */
const mayGoOn = (id: string, order: string[], ready: string[]): boolean =>
  id !== SAVED || order[0] === SAVED || (ready.length === 1 && ready[0] === id);

/**
 * The agent ion's own model goes on when none is set or its own failed (Plan 21 audit, 2026-11-23: the judge quietly
 * went on Claude Code at Opus): the first in your order that's ready, not limited and not one of `not`; Claude Code
 * only when it's first in your order or the only one ready. None: undefined.
 */
export function nextInOrder(o: {
  order: string[];
  ready: string[];
  limited?: (id: string) => boolean;
  not?: string[];
  /** Every agent ready, when `ready` is only those fit for the work (a dream's: its web off). */
  signedIn?: string[];
}): string | undefined {
  const all = o.signedIn ?? o.ready;
  return byPreference(o.ready, o.order).find(
    (id) => !o.not?.includes(id) && !o.limited?.(id) && mayGoOn(id, o.order, all),
  );
}

/** These agents, but Claude Code unless it's first in your order or the only one ready. */
export const savingClaude = (ids: string[], order: string[], ready: string[]): string[] =>
  ids.filter((id) => mayGoOn(id, order, ready));

/** "<agent>:<its pinned judge model>", as its adapter pins it (PR #36 re-review, 2026-11-23), else undefined. */
export function judgePin(id: string): string | undefined {
  const j = getHarness(id)?.adapter.judge;
  return j ? `${id}:${j.model}` : undefined;
}

/** Whether ion ran its judge checks on this agent's pinned model before shipping it (the adapter says when). */
export const shippedChecked = (id: string): boolean => !!getHarness(id)?.adapter.judge?.checked;

/**
 * These agents strongest first, by the rank each adapter gives its strongest model (the user, 2026-11-23: ion's brain
 * is "the strongest model you're signed in to"); equal ranks keep their order.
 */
export const byStrength = (ids: string[]): string[] =>
  [...ids].sort(
    (a, b) => (getHarness(b)?.adapter.brain?.rank ?? 0) - (getHarness(a)?.adapter.brain?.rank ?? 0),
  );

/** An agent's strongest model for ion's brain, as its adapter says; null: its own default. */
export const brainModel = (id: string): string | null => getHarness(id)?.adapter.brain?.model ?? null;

/** These agents but the ones you marked "Avoid unless I ask" (PR #36 final review, 2026-11-24). */
export const notAvoided = (ids: string[], c: { agents?: Record<string, { avoid?: boolean } | undefined> }) =>
  ids.filter((id) => !c.agents?.[id]?.avoid);

/** An agent's name as ion says it ("Claude Code"), else its id. */
export const agentLabel = (id: string): string => getHarness(id)?.label ?? id;

/** Which agents ion can pass skills to (Plan 18, Task 5): Claude Code, through the Agent SDK's plugins. */
const SKILLS = new Set(["claude-code"]);

/**
 * Whose skill folders each agent reads itself (ion passes them nothing): Codex reads `~/.codex/skills` and
 * `.agents/skills`; opencode its own, Claude's and `.agents/skills`; Grok its own, Claude's and `.agents/skills`
 * (`grok inspect`, Grok 1.0.92; the user, 2026-11-22).
 */
const OWN_SKILLS: Record<string, SkillWhose[]> = {
  codex: ["codex", "shared"],
  opencode: ["opencode", "claude", "shared"],
  "grok-build": ["grok", "claude", "shared"],
};

/** By agent id, for the agents the app lists: whether it takes skills from ion, and whose folders it reads itself. */
export function skillReaders(): Record<string, { fromIon: boolean; own: SkillWhose[] }> {
  return Object.fromEntries(
    listedHarnessIds().map((id) => [id, { fromIon: SKILLS.has(id), own: OWN_SKILLS[id] ?? [] }]),
  );
}

/** How an agent takes what you picked with "/" (its adapter says; "tell" for one that doesn't). */
export const pickStyle = (id: string): PickStyle => getHarness(id)?.adapter.picks ?? "tell";

/** Whether an agent reads MCP resources (its adapter says): "@" lists them only for one that does. */
export const takesResources = (id: string): boolean => getHarness(id)?.adapter.mcpResources === true;

/** Whether ion passes skills to this agent (a plugin folder per run). */
export const takesSkills = (id: string): boolean => SKILLS.has(id);

/**
 * What each agent can take from ion, by agent id, for the agents the app lists: MCP servers (every one reaches the
 * agent at ion's URL for it, a local one run by ion, so an agent that takes http takes both), and skills.
 */
export function toolSupport(): Record<string, { http: boolean; stdio: boolean; skills: boolean }> {
  return Object.fromEntries(
    listedHarnessIds().map((id) => {
      const http = getHarness(id)?.adapter.mcpTransports.http ?? false;
      return [id, { http, stdio: http, skills: SKILLS.has(id) }];
    }),
  );
}
