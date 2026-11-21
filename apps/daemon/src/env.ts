import { homedir } from "node:os";
import { RUN_ENV_PREFIXES, RUN_ENV_VARS } from "@ion/adapter-kit";

/**
 * Drops every per-run variable the daemon may have inherited (started from a chat's tool call: the chat marker,
 * the run's gate address and key, its MCP keys), so ion chief, the project ions and the judge never carry another
 * run's: only a run sets them. Safe to call again.
 */
export function dropInheritedMarkers(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of RUN_ENV_VARS) delete env[k];
  for (const k of Object.keys(env)) if (RUN_ENV_PREFIXES.some((p) => k.startsWith(p))) delete env[k];
}

/**
 * Where ion reads your agents' own configs (their servers for Import, their skills): your home, or ION_AGENTS_HOME
 * (the tour points it at a fake one so it never reads yours). Nothing else follows it.
 */
export const agentsHome = (env: NodeJS.ProcessEnv = process.env): string => env.ION_AGENTS_HOME || homedir();
