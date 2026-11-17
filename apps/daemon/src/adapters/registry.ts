// The only place the daemon loads harness adapters (lint: ion/walls).
import { createAcpAdapter, GROK_BUILD, OPENCODE } from "@ion/adapter-acp";
import { createClaudeCodeAdapter } from "@ion/adapter-claude-code";
import { createFakeAdapter } from "@ion/adapter-fake";
import type { HarnessAdapter } from "@ion/adapter-kit";

export type HarnessEntry = { adapter: HarnessAdapter; label: string; loginHint: string };

const ENTRIES: Record<string, () => HarnessEntry> = {
  "claude-code": () => ({
    adapter: createClaudeCodeAdapter(),
    label: "Claude Code",
    loginHint: "claude auth login",
  }),
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

/** A harness by id, or null. The fake harness exists only for tests (ION_ALLOW_FAKE=1). */
export function getHarness(id: string): HarnessEntry | null {
  if (id === "fake" && process.env.ION_ALLOW_FAKE === "1")
    return { adapter: createFakeAdapter(), label: "Fake", loginHint: "nothing to do" };
  return ENTRIES[id]?.() ?? null;
}
