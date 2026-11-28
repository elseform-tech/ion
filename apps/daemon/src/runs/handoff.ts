import type { GateCall } from "@ion/adapter-kit";
import type { CallKey } from "../gate/queue.js";

/**
 * A call on one of your servers is decided twice without this: on the agent's side (its hook or permission prompt)
 * and at ion's gateway. The agent side's allow of exactly the call (server, tool and arguments) is handed to the
 * gateway, which then doesn't ask the judge (or you) again. Anything that doesn't match is decided in full.
 */
export const HANDOFF_MS = 10_000;

/** JSON with its keys sorted, so the same arguments match however an agent ordered them. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );

/** Where ion checks a call: the agent's hook (gate), its permission prompt, ion's gateway. */
export type Side = "gate" | "prompt" | "gateway";

/** Keys are JSON arrays: no string an agent types can pass for another part (security review, 2026-11-28, M1). */
const keyOf = (server: string, tool: string, args: unknown): CallKey => ({
  kind: "mcp",
  id: JSON.stringify([server, tool, canon(args)]),
});

/** How agents name a server's tool: Claude `mcp__s__t`, Grok `s__t`, opencode `s_t`. */
const prefixes = (s: string) => [`mcp__${s}__`, `${s}__`, `${s}_`];

const isObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

const GROK_WRAP = new Set(["variant", "tool_name", "tool_input"]);

/** A call as ion checks it, with the keys its harness added to the tool's own input. */
type Checked = GateCall & { added?: string[] };

/**
 * A call's arguments as judged, all of them (security review, 2026-11-28, I2): Grok's hook wraps them as exactly
 * `{variant?, tool_name, tool_input}`, naming the call's own tool, and only that shape is unwrapped; keys the harness
 * says it added (ACP's `locations` at its permission prompt) are left out, never a tool's own (re-review, N5).
 */
function argsOf(call: Checked): Record<string, unknown> {
  const input = call.input;
  const keys = Object.keys(input);
  if (keys.every((k) => GROK_WRAP.has(k)) && input.tool_name === call.toolName && isObject(input.tool_input))
    return input.tool_input;
  const added = new Set(call.added ?? []);
  return added.size ? Object.fromEntries(Object.entries(input).filter(([k]) => !added.has(k))) : input;
}

/**
 * The key of an agent-side call on one of the servers ion's gateway serves for this run; null for any other. By the
 * server the harness names when it does; else by the tool's name only when one server alone fits it (re-review,
 * 2026-11-28, N6: with `a` and `a_b`, `a_b_t` read two ways).
 */
export function agentKey(call: Checked, viaIon: string[]): CallKey | null {
  const named = (s: string) => prefixes(s).find((p) => call.toolName.startsWith(p));
  const fits = viaIon.filter((s) => named(s));
  const only = fits.length === 1 ? fits[0] : null;
  const server = call.mcpServer && viaIon.includes(call.mcpServer) ? call.mcpServer : only;
  if (!server) return null;
  const p = named(server);
  return keyOf(server, p ? call.toolName.slice(p.length) : call.toolName, argsOf(call));
}

/** The key of a tools/call at ion's gateway: its server, real tool name and arguments. */
export const gatewayKey = (call: GateCall): CallKey => keyOf(call.mcpServer ?? "", call.toolName, call.input);

/**
 * The same call wherever ion checks it, on everything that was judged (security review, 2026-11-28, I2): a call on
 * one of the run's servers ion's gateway serves by its server, tool and arguments (as the handoff matches it); any
 * other by its kind, server, tool and whole input.
 */
export function sameCallKey(call: Checked, side: Side, viaIon: string[] = []): string {
  const mcp = side === "gateway" ? gatewayKey(call) : agentKey(call, viaIon);
  if (mcp) return JSON.stringify(["mcp", mcp.id]);
  return JSON.stringify(["call", call.kind, call.mcpServer ?? null, call.toolName, canon(argsOf(call))]);
}
