import { loadUserConfig } from "@ion/config";
import type { ToolCheck } from "@ion/schema";
import { type Found, readAgentServers } from "../tools/import.js";
import type { McpServer } from "../tools/mcp-file.js";
import { agentsHomeOf } from "../tools/own-run.js";
import type { Ctx } from "./commands.js";
import { localProblems, offRemoteProblems } from "./tools-doctor.js";
import { projectDirs } from "./tools-entries.js";

/** An agent's own server as ion's checks read it: nothing filled, no headers. */
function serverOf(f: Found): McpServer {
  return "command" in f.entry
    ? { name: f.name, transport: "stdio", command: f.entry.command, args: f.entry.args ?? [], env: {} }
    : { name: f.name, transport: "http", url: f.entry.url, headers: {} };
}

/**
 * Your agents' own servers (the user, 2026-11-21: "sure"), checked read-only like a server of ion's that's off: its
 * command or package is there, or its URL as written answers (public addresses only). Never started, nothing filled;
 * each agent manages its own. A project's own file's servers are left out (the repo wrote them).
 */
export async function ownServerChecks(ctx: Ctx, name?: string): Promise<ToolCheck[]> {
  const { config } = loadUserConfig(ctx.configFile);
  const read = readAgentServers({ ...agentsHomeOf(ctx.skills), projects: projectDirs(config) });
  const mine = read.found.filter((f) => !f.repo && (name === undefined || f.name === name));
  return Promise.all(
    mine.map(async (f) => {
      const s = serverOf(f);
      const problems =
        s.transport === "stdio" ? await localProblems(ctx, s) : await offRemoteProblems(ctx, s);
      return {
        kind: "mcp" as const,
        name: f.name,
        id: `${f.agent}:${f.name}`,
        on: true,
        agent: f.agent,
        problems,
      };
    }),
  );
}
