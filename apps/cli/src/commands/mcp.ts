import type { ImportInfo, ImportResult, RegistryHit } from "@ion/schema";
import type { Command } from "commander";
import { withClient } from "../connect.js";
import { fail, type Out, print, table } from "../output.js";
import { clean } from "../sanitize.js";
import { addedLine, toolVerbs } from "./tool-verbs.js";

const many = (v: string, all: string[] = []) => [...all, v];

/** "NAME=value" pairs (env) or "Name: value" pairs (headers), as a map. */
function pairs(list: string[] | undefined, sep: "=" | ":"): Record<string, string> | undefined {
  if (!list?.length) return undefined;
  return Object.fromEntries(
    list.map((p) => {
      const i = p.indexOf(sep);
      if (i < 1) fail(sep === "=" ? `Use NAME=\${NAME}: ${clean(p)}` : `Use "Name: value": ${clean(p)}`);
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
}

const runLine = (r: RegistryHit["run"][number]) =>
  "url" in r ? `  url: ${clean(r.url)}` : `  run: ${clean([r.command, ...r.args].join(" "))}`;

/** The keys it needs: env names, and headers marked as such. */
const keysOf = (h: RegistryHit) =>
  [...h.keys, ...h.headers.map((n) => `${n} (header)`)].map(clean).join(", ");

/** One registry server: how its publisher runs it, the keys it needs, its source. Registry text is shown as data. */
const hitLines = (h: RegistryHit) =>
  [
    clean(h.id),
    ...(h.description ? [`  ${clean(h.description)}`] : []),
    ...h.run.map(runLine),
    `  keys: ${keysOf(h) || "none"}`,
    ...(h.source ? [`  source: ${clean(h.source)}`] : []),
  ].join("\n");

type AddOpts = {
  command?: string;
  arg?: string[];
  env?: string[];
  url?: string;
  header?: string[];
  from?: string;
};

/** What Import would bring in: each server, its agent and the keys it needs; then what can't come in, and why. */
const importList = (i: ImportInfo) =>
  [
    i.servers.length
      ? table(
          i.servers.map((s) => [
            clean(s.name),
            clean(placeOf(s)),
            clean(s.line),
            s.keys.map(clean).join(", "),
          ]),
        )
      : "Nothing to import",
    ...i.skipped.map((s) => clean(`${s.name} (${agentName(s.agent)}): ${s.why}`)),
    ...i.problems.map(clean),
  ].join("\n");

const AGENTS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  "grok-build": "Grok Build",
};
const agentName = (id: string) => AGENTS[id] ?? id;

/** Your agent, or a project's own file (the repo wrote it, not you). */
const placeOf = (s: ImportInfo["servers"][number]) =>
  s.repo ? `${s.repo.project}'s ${s.repo.file}` : s.from;

/** `--from`: an agent's id, or a project's own file as `project:file` (its servers come in only when it's named). */
function fromOf(f: string | undefined): { agent?: string; repo?: string } {
  if (!f) return {};
  return f.includes(":") ? { repo: f } : { agent: f };
}

/** Whether a listed server is one `--from` names. */
const shownFrom = (s: ImportInfo["servers"][number], f: { agent?: string; repo?: string }) =>
  f.repo ? !!s.repo && `${s.repo.project}:${s.repo.file}` === f.repo : !f.agent || s.agent === f.agent;

/** What came in (off), and each one that didn't, with why. */
const importedLines = (r: ImportResult) =>
  [
    r.imported.length ? `Imported, off: ${r.imported.map((i) => clean(i.name)).join(", ")}` : "",
    ...r.skipped.map((s) => clean(`${s.name}: ${s.why}`)),
  ]
    .filter(Boolean)
    .join("\n") || "Nothing to import";

/** `ion mcp …`: the MCP servers in your mcp.json. One added starts off; you turn it on in Settings → Tools. */
export function mcpCommands(program: Command, out: () => Out) {
  const m = program.command("mcp").description("MCP servers");
  m.command("search <name>")
    .description("Look it up in the official MCP Registry")
    .action(async (name: string) => {
      const hits = await withClient((c) => c.call("tools.search", { query: name }));
      print(out(), hits.length ? hits.map(hitLines).join("\n\n") : "Nothing found", hits);
    });
  m.command("add <name> [args...]")
    .description("Add one, off")
    .option("--command <cmd>", "What it runs")
    .option("--arg <arg>", "One argument (repeat it)", many)
    .option("--env <NAME=${NAME}>", "An env variable (repeat it)", many)
    .option("--url <url>", "Its URL, for a remote one")
    .option("--header <Name: value>", "A header (repeat it)", many)
    .option("--from <id or link>", "Its registry id or source link")
    .action(async (name: string, rest: string[], o: AddOpts) => {
      const env = pairs(o.env, "=");
      const headers = pairs(o.header, ":");
      const item = await withClient((c) =>
        c.call("tools.add", {
          ...{ kind: "mcp", name },
          ...(o.command ? { command: o.command, args: [...(o.arg ?? []), ...rest] } : {}),
          ...(o.url ? { url: o.url } : {}),
          ...(env ? { env } : {}),
          ...(headers ? { headers } : {}),
          ...(o.from ? { from: o.from } : {}),
        }),
      );
      print(out(), addedLine(item), item);
    });
  importCommand(m, out);
  toolVerbs(m, "mcp", out);
}

/** `ion mcp import`: your other agents' servers, shown before any comes in, then brought in off. */
function importCommand(m: Command, out: () => Out) {
  m.command("import [names...]")
    .description("Bring yours in from your other agents, off")
    .option("--list", "Only list them")
    .option("--all", "All of yours (not ones in a project's own files)")
    .option(
      "--from <agent or file>",
      "One agent's (claude-code, codex, opencode, grok-build), or a project's file (shop:.mcp.json)",
    )
    .action(async (names: string[], o: { list?: boolean; all?: boolean; from?: string }) => {
      const from = fromOf(o.from);
      // Nothing comes in unseen (security review, 2026-11-21): with no names, what would, and how.
      if (o.list || (!names.length && !o.all && !from.repo)) {
        const all = await withClient((c) => c.call("tools.importable", {}));
        const info = { ...all, servers: all.servers.filter((s) => shownFrom(s, from)) };
        const how = o.list || !info.servers.length ? "" : "\nName them, or use --all";
        return print(out(), importList(info) + how, info);
      }
      const r = await withClient((c) =>
        c.call("tools.import", { ...from, ...(names.length ? { names } : {}) }),
      );
      print(out(), importedLines(r), r);
    });
}
