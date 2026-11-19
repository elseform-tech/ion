// The only place the daemon loads harness adapters (lint: ion/walls).
import { createAcpAdapter, GROK_BUILD, OPENCODE } from "@ion/adapter-acp";
import { createClaudeCodeAdapter } from "@ion/adapter-claude-code";
import { createCodexAdapter } from "@ion/adapter-codex";
import { createFakeAdapter } from "@ion/adapter-fake";
import type { HarnessAdapter } from "@ion/adapter-kit";

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
