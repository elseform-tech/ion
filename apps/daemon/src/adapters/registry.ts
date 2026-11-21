// The only place the daemon loads harness adapters (lint: ion/walls).
import { createAcpAdapter, GROK_BUILD, OPENCODE } from "@ion/adapter-acp";
import { createClaudeCodeAdapter } from "@ion/adapter-claude-code";
import { createCodexAdapter } from "@ion/adapter-codex";
import { createFakeAdapter } from "@ion/adapter-fake";
import type { HarnessAdapter, PickStyle } from "@ion/adapter-kit";
import type { SkillWhose } from "@ion/schema";

export type HarnessEntry = { adapter: HarnessAdapter; label: string; loginHint: string };

const ENTRIES: Record<string, () => HarnessEntry> = {
  "claude-code": () => ({
    adapter: createClaudeCodeAdapter(),
    label: "Claude Code",
    loginHint: "claude auth login",
  }),
  codex: () => ({ adapter: createCodexAdapter(), label: "Codex", loginHint: "codex login" }),
  "grok-build": () => ({
    adapter: createAcpAdapter(GROK_BUILD),
    label: GROK_BUILD.label,
    loginHint: GROK_BUILD.loginHint,
  }),
  opencode: () => ({
    adapter: createAcpAdapter(OPENCODE),
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
      adapter: createFakeAdapter({ signedIn: process.env.ION_FAKE_SIGNED_OUT !== "1" }),
      label: "Fake",
      loginHint: "ion fake login",
    };
  return ENTRIES[id]?.() ?? null;
}

/** Without one chosen: the first ready of these (quota-friendly first), else any ready one. */
const PREFERRED = ["opencode", "grok-build", "codex", "claude-code"];

/** The agent to use when none is named: the chat's own while it's ready, else the first ready one. */
export function defaultAgent(ready: string[], own: string | null): string | undefined {
  if (own && ready.includes(own)) return own;
  return PREFERRED.find((id) => ready.includes(id)) ?? ready[0];
}

/** Which agents ion can pass skills to (Plan 18, Task 5): Claude Code, through the Agent SDK's plugins. */
const SKILLS = new Set(["claude-code"]);

/**
 * Whose skill folders each agent reads itself (ion passes them nothing): Codex reads `~/.codex/skills` and
 * `.agents/skills`; opencode its own, Claude's and `.agents/skills`.
 */
const OWN_SKILLS: Record<string, SkillWhose[]> = {
  codex: ["codex", "shared"],
  opencode: ["opencode", "claude", "shared"],
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
