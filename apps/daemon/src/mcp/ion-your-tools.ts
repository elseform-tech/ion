import type { McpServer as Mcp } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type SkillInfo, type SkillWhose, stripControl, type ToolSupport } from "@ion/schema";
import { z } from "zod";
import { UserError } from "../api/errors.js";
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
  /** A listed skill's SKILL.md after its front matter (that exact skill, while it's on); null otherwise. */
  body?: (s: SkillInfo) => string | null;
}>;

/** The most of a skill's instructions an ion reads at once. */
const BODY_MAX = 16_000;

const OWNER: Record<SkillWhose, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  grok: "Grok Build",
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
        "The user's connections (MCP servers) and skills, by name: which are on, and which agents get them. With a skill's name, that skill's instructions: follow them in your own answer, or name the skill in start_thread's skills so a thread uses it. You never run a skill's scripts.",
      inputSchema: { skill: z.string().min(1).max(200).optional() },
    },
    guard(async ({ skill }: { skill?: string }) => {
      if (!ion.yours) return ok(wrapData("your tools", "None."));
      const { servers, skills, support, body } = await ion.yours(ion.dirs());
      const reached = skills.filter((s) => ion.chief || skillAgents(s).length > 0);
      if (skill !== undefined) return skillText(skill, reached, body);
      const http = Object.keys(support).filter((id) => support[id]!.http);
      const shown = servers.filter((s) => ion.chief || s.on);
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

/** A skill's instructions for an ion, as data: read and followed in its own answer, its scripts never run. */
function skillText(name: string, reached: SkillInfo[], body?: (s: SkillInfo) => string | null) {
  const shown = stripControl(name).slice(0, 60);
  // Only a skill that's on (or an agent's own); a name two different skills share is refused (security review).
  const named = reached.filter((s) => s.name === name && (s.on || s.own));
  if (new Set(named.map((s) => s.hash)).size > 1)
    throw new UserError(`More than one skill is named ${shown}`);
  const md = named[0] ? body?.(named[0]) : null;
  if (!md) throw new UserError(`No skill named ${shown}`);
  const text = stripControl(md).slice(0, BODY_MAX);
  return ok(
    [
      "Follow these in your own answer; never run its scripts (a thread can, with the skill in start_thread's skills).",
      wrapData(`the ${name} skill's instructions`, text),
    ].join("\n\n"),
  );
}
