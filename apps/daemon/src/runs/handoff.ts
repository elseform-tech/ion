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

const keyOf = (server: string, tool: string, args: unknown): CallKey => ({
  kind: "mcp",
  id: `${server}\n${tool}\n${canon(args)}`,
});

/** How agents name a server's tool: Claude `mcp__s__t`, Grok `s__t`, opencode `s_t`. */
const prefixes = (s: string) => [`mcp__${s}__`, `${s}__`, `${s}_`];

const isObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

const WRAPPING = new Set(["locations", "variant", "tool_name"]);

/** What an agent wraps around a tool's arguments: Grok's `{variant, tool_name, tool_input}`, ACP's locations. */
function argsOf(input: Record<string, unknown>): Record<string, unknown> {
  if (isObject(input.tool_input)) return input.tool_input;
  return Object.fromEntries(Object.entries(input).filter(([k]) => !WRAPPING.has(k)));
}

/** The key of an agent-side call on one of the servers ion's gateway serves for this run; null for any other. */
export function agentKey(call: GateCall, viaIon: string[]): CallKey | null {
  const named = (s: string) => prefixes(s).find((p) => call.toolName.startsWith(p));
  const server =
    call.mcpServer && viaIon.includes(call.mcpServer) ? call.mcpServer : viaIon.find((s) => named(s));
  if (!server) return null;
  const p = named(server);
  return keyOf(server, p ? call.toolName.slice(p.length) : call.toolName, argsOf(call.input));
}

/** The key of a tools/call at ion's gateway: its server, real tool name and arguments. */
export const gatewayKey = (call: GateCall): CallKey => keyOf(call.mcpServer ?? "", call.toolName, call.input);
