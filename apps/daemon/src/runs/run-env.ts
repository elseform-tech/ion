import { delimiter } from "node:path";
import type { Grants } from "../mcp/index.js";

/** A run's keys: for ion's MCP server, the gate (when its harness has a hook) and ion's commands (`ION_RUN_KEY`). */
export type RunKeys = { mcpKey?: string; gateKey?: string; cliKey?: string };

/**
 * A run's keys, each good until the run ends: for ion's MCP server (and its gateway), for the gate (`gate`: its harness
 * reports calls through a hook), and for ion's commands for tools (`ION_RUN_KEY`, the `ion` CLI inside the chat).
 */
export function runKeys(
  grants: Grants | undefined,
  l: { projectId: string; chatId: string; runId: string },
  gate: boolean,
): RunKeys {
  if (!grants) return {};
  const scope = { kind: "run" as const, projectId: l.projectId, chatId: l.chatId, runId: l.runId };
  return {
    mcpKey: grants.create(scope),
    ...(gate ? { gateKey: grants.create(scope, "gate") } : {}),
    cliKey: grants.create(scope, "cli"),
  };
}

/**
 * What a run's agent process is given in its environment: the chat's marker (every process it starts inherits it),
 * the run's key for ion's commands and ion's port (daemon.json is out of the run's reach in its sandbox), and ion's
 * own launcher first on its PATH, so `ion` is found.
 */
export function runEnv(
  l: { chatId: string; cliKey?: string },
  ionBin: string | undefined,
  port?: number,
): Record<string, string> {
  return {
    ION_CHAT: l.chatId,
    ...(l.cliKey ? { ION_RUN_KEY: l.cliKey } : {}),
    ...(l.cliKey && port ? { ION_PORT: String(port) } : {}),
    ...(ionBin ? { PATH: [ionBin, process.env.PATH ?? ""].filter(Boolean).join(delimiter) } : {}),
  };
}
