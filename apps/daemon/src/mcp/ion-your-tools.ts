import type { McpServer as Mcp } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillInfo, SkillWhose, ToolSupport } from "@ion/schema";
import { wrapData } from "../context/index.js";
import { type McpServer, shownCommand, shownHost } from "../tools/index.js";
import { guard, ok } from "./result.js";

/**
 * Your tools as an ion may know them: each connection from mcp.json (as written, keys and all: only its name, host or
 * program ever leave here) and whether it's on; the skills found in your home and these projects' folders; and what
 * each agent takes.
 */
export type YourTools = (projectDirs: string[]) => Promise<{
  servers: { server: McpServer; on: boolean }[];
  skills: SkillInfo[];
  support: Record<string, ToolSupport>;
}>;

const OWNER: Record<SkillWhose, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  shared: "every agent",
  ion: "ion",
};

/** A connection in a line: its name, where it is (a host, or a program's name), on or off, and the agents it reaches. */
function connectionLine(server: McpServer, on: boolean, agents: string[]): string {
  const where = server.transport === "http" ? shownHost(server.url) : shownCommand(server.command);
  const reach = on && agents.length ? `; agents ${agents.join(", ")}` : "";
  return `- ${server.name} (${where}): ${on ? "on" : "off"}${reach}`;
}

/** The agents a skill reaches: those ion passes it to while it's on, and those that read its folder themselves. */
const skillAgents = (s: SkillInfo) =>
  Object.entries(s.support)
    .filter(([, how]) => how === "own" || s.on)
    .map(([id]) => id);

function skillLine(s: SkillInfo): string {
  const agents = skillAgents(s);
  const reach = agents.length ? `; agents ${agents.join(", ")}` : "";
  return `- ${s.name}: ${s.description} (${OWNER[s.whose]}; ${s.on ? "on" : "off"}${reach})`;
}

/**
 * `tools`: your connections and skills by name, for an ion to know which a project's thread could use. ion chief
 * sees all of them (its projects' skills); a project's ion only what its project's chats would get.
 */
export function registerYourTools(
  server: Mcp,
  ion: { chief: boolean; dirs: () => string[]; yours?: YourTools },
): void {
  server.registerTool(
    "tools",
    {
      description:
        "The user's connections (MCP servers) and skills, by name: which are on, and which agents get them. You can't use them; a thread in a project can.",
      inputSchema: {},
    },
    guard(async () => {
      if (!ion.yours) return ok(wrapData("your tools", "None."));
      const { servers, skills, support } = await ion.yours(ion.dirs());
      const http = Object.keys(support).filter((id) => support[id]!.http);
      const shown = servers.filter((s) => ion.chief || s.on);
      const reached = skills.filter((s) => ion.chief || skillAgents(s).length > 0);
      const lines = [
        "Connections:",
        ...(shown.length ? shown.map((s) => connectionLine(s.server, s.on, http)) : ["- none"]),
        "Skills:",
        ...(reached.length ? reached.map(skillLine) : ["- none"]),
      ];
      return ok(wrapData("your tools", lines.join("\n")));
    }),
  );
}
