import type { GateCall } from "@ion/adapter-kit";
import { mcpServerOf, toolKind, toolSummary } from "./tools.js";

type HookOutput = {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
};
type Hook = (
  input: unknown,
  toolUseId: string | undefined,
  o: { signal: AbortSignal },
) => Promise<HookOutput>;

const deny = (reason: string): HookOutput => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

/**
 * Claude Code's PreToolUse hook, passed in through the SDK (no file anywhere): every tool call is reported to
 * ion's gate before it runs, even ones Claude Code would run without asking. An allow lets Claude Code's own
 * checks go on; anything else, or no answer, denies.
 */
export function gateHooks(url: string): { PreToolUse: { hooks: Hook[] }[] } {
  const hook: Hook = async (input, _id, o) => {
    const i = (input ?? {}) as { tool_name?: unknown; tool_input?: unknown };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool_name: i.tool_name, tool_input: i.tool_input }),
        signal: AbortSignal.any([o.signal, AbortSignal.timeout(60_000)]),
      });
      const a = (await res.json()) as { decision?: unknown; reason?: unknown };
      if (a.decision === "allow") return {};
      return deny(typeof a.reason === "string" ? a.reason : "Not allowed by ion");
    } catch {
      return deny("ion didn't answer, so this was blocked");
    }
  };
  return { PreToolUse: [{ hooks: [hook] }] };
}

/** The hook's `{tool_name, tool_input}` as one tool call. */
export function claudeGateCall(payload: unknown): GateCall | null {
  const p = (payload ?? {}) as { tool_name?: unknown; tool_input?: unknown };
  if (typeof p.tool_name !== "string" || !p.tool_input || typeof p.tool_input !== "object") return null;
  const input = p.tool_input as Record<string, unknown>;
  return {
    toolName: p.tool_name,
    kind: toolKind(p.tool_name),
    summary: toolSummary(p.tool_name, input, [], { full: true }),
    input,
    mcpServer: mcpServerOf(p.tool_name),
  };
}
