import { loadUserConfig } from "@ion/config";
import type {
  Commands,
  ImportInfo,
  ImportPrompt,
  ImportResult,
  ImportableServer,
  ToolItem,
} from "@ion/schema";
import { launchHash } from "../tools/added.js";
import { type AgentServers, type Found, readAgentServers } from "../tools/import.js";
import { agentsHomeOf } from "../tools/own-run.js";
import type { McpServer } from "../tools/mcp-file.js";
import type { Ctx, Handlers } from "./commands.js";
import { UserError } from "./errors.js";
import { addTool } from "./tools-add.js";
import { mcpHash, originOf, projectDirs } from "./tools-entries.js";

/** What ion remembers it has shown of a server in an agent's config (its name and what it runs). */
const seenKey = (f: Found) => `import:${f.agent}:${f.name}:${launchHash(f.entry)}`;
/** An agent whose Import line was dismissed or used once: from then on, only what's new in it is said. */
const told = (agent: string) => `import:${agent}`;

/**
 * Your agents' servers, read now (only on opening Tools, or `ion mcp import --list`): those not in mcp.json, each
 * name once. In tests (a home that isn't yours) ion's environment isn't followed.
 */
function scan(ctx: Ctx): { read: AgentServers; listed: Found[] } {
  const { config } = loadUserConfig(ctx.configFile);
  const read = readAgentServers({ ...agentsHomeOf(ctx.skills), projects: projectDirs(config) });
  const file = ctx.tools.read();
  const taken = new Set([...file.servers, ...file.leftOut].map((s) => s.name.toLowerCase()));
  // Yours first, then any in a project's own file (task review, 2026-11-21: a repo's server hid yours of that name).
  const ordered = [...read.found.filter((f) => !f.repo), ...read.found.filter((f) => f.repo)];
  const listed = ordered.filter((f) => {
    const n = f.name.toLowerCase();
    if (taken.has(n)) return false;
    taken.add(n);
    return true;
  });
  return { read, listed };
}

/** What it runs, or the host it connects to. */
function lineOf(f: Found): string {
  if ("command" in f.entry) return [f.entry.command, ...(f.entry.args ?? [])].join(" ");
  try {
    return new URL(f.entry.url).host;
  } catch {
    return f.entry.url;
  }
}

/**
 * One line per agent with servers ion hasn't shown: the first time all of them, later only the new ones. Never one
 * from a project's own file (security review, 2026-11-21: the repo wrote it, not you).
 */
function promptsOf(ctx: Ctx, all: Found[]): ImportPrompt[] {
  const listed = all.filter((f) => !f.repo);
  const agents = [...new Set(listed.map((f) => f.agent))];
  return agents.flatMap((agent) => {
    const mine = listed.filter((f) => f.agent === agent);
    const fresh = mine.filter((f) => !ctx.seen.has(seenKey(f)));
    if (!fresh.length) return [];
    const first = !ctx.seen.has(told(agent));
    return [{ agent, from: mine[0]!.from, names: (first ? mine : fresh).map((f) => f.name), first }];
  });
}

function importInfo(ctx: Ctx): ImportInfo {
  const { read, listed } = scan(ctx);
  const servers: ImportableServer[] = listed.map((f) => ({
    ...{ agent: f.agent, from: f.from, name: f.name, line: lineOf(f), keys: f.keys },
    transport: "command" in f.entry ? "stdio" : "http",
    ...(ctx.seen.has(seenKey(f)) ? {} : { new: true as const }),
    ...(f.repo ? { repo: f.repo } : {}),
  }));
  return { servers, prompts: promptsOf(ctx, listed), problems: read.problems, skipped: read.skipped };
}

/** The server as ion reads it back from mcp.json (what its record of where it came from is keyed by). */
const asRead = (f: Found): McpServer =>
  "command" in f.entry
    ? {
        name: f.name,
        transport: "stdio",
        command: f.entry.command,
        args: f.entry.args ?? [],
        env: f.entry.env ?? {},
      }
    : { name: f.name, transport: "http", url: f.entry.url, headers: f.entry.headers ?? {} };

/** One server into mcp.json, off, as `ion mcp add` adds it, marked as imported from its agent. */
async function importOne(ctx: Ctx, f: Found): Promise<ToolItem> {
  const item = await addTool(ctx, { kind: "mcp", name: f.name, ...f.entry });
  const hash = mcpHash(asRead(f));
  ctx.added.put({
    kind: "mcp",
    name: item.id,
    hash,
    source: f.repo ? `From ${f.repo.project}'s ${f.repo.file}` : `Imported from ${f.from}`,
    at: new Date().toISOString(),
  });
  const origin = originOf(ctx, "mcp", item.id, hash);
  return { ...item, ...(origin ? { origin } : {}) };
}

/** Its project and file, as `--from` names it: `shop:.mcp.json`. */
const repoOf = (f: Found) => (f.repo ? `${f.repo.project}:${f.repo.file}` : undefined);

/**
 * Which servers an import means: yours by agent and name (none named: all of yours); one from a project's own file
 * only when that file is named too (security review and task review, 2026-11-21: the repo wrote it, not you).
 */
function wanted(f: Found, a: Commands["tools.import"]["args"], names: string[] | null): boolean {
  if (a.agent && f.agent !== a.agent) return false;
  if (f.repo) return a.repo === repoOf(f) && (!names || names.includes(f.name));
  return !a.repo && (!names || names.includes(f.name));
}

async function importServers(ctx: Ctx, a: Commands["tools.import"]["args"]): Promise<ImportResult> {
  const names = Array.isArray(a.names) ? a.names.map(String) : null;
  const picked = scan(ctx).listed.filter((f) => wanted(f, a, names));
  const out: ImportResult = { imported: [], skipped: [] };
  for (const f of picked) {
    try {
      out.imported.push(await importOne(ctx, f));
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      out.skipped.push({ name: f.name, why: e.message });
    }
  }
  ctx.seen.add([...picked.map(seenKey), ...new Set(picked.map((f) => told(f.agent)))]);
  return out;
}

/** Hides the Import line (an agent's, or every one) until something ion hasn't seen appears. */
function dismiss(ctx: Ctx, agent: string | undefined): ImportInfo {
  const { listed } = scan(ctx);
  const mine = listed.filter((f) => !f.repo && (!agent || f.agent === agent));
  const agents = agent ? [agent] : [...new Set(listed.map((f) => f.agent))];
  ctx.seen.add([...mine.map(seenKey), ...agents.map(told)]);
  return importInfo(ctx);
}

/** Import: your agents' own servers into mcp.json, off. Only you (a chat's agent is refused before it gets here). */
export const toolsImportHandlers: Pick<
  Handlers,
  "tools.importable" | "tools.import" | "tools.dismissImport"
> = {
  "tools.importable": (_a, ctx) => importInfo(ctx),
  "tools.import": (a, ctx) => importServers(ctx, a),
  "tools.dismissImport": (a, ctx) => dismiss(ctx, a.agent === undefined ? undefined : String(a.agent)),
};
