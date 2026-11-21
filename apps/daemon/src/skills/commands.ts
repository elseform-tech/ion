import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripControl } from "@ion/schema";
import { readFile } from "../tools/import.js";
import { readPlugins } from "../tools/plugins.js";

/**
 * Each agent's own commands, as "/" lists them (the user, 2026-11-21, after Task 13: the agent's own come first):
 * Claude Code's (`~/.claude/commands`, its enabled plugins' as `plugin:name`), opencode's (its `command` folders and
 * its config's `command`), Codex's custom prompts (`prompts:name`). Only read: nothing is run. `body`: the command's
 * text, for an agent that can't run it by name.
 */
export type OwnCommand = { name: string; description: string; body: string };

type ReadOpts = { home: string; env: Record<string, string | undefined>; projects: string[] };

const MAX_FILE = 64 * 1024;
const MAX_COMMANDS = 200;
const NAME = /^[\w.:-]{1,80}$/;

const clean = (s: string, max: number) => stripControl(s.replace(/\s+/g, " ")).trim().slice(0, max);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A markdown command's description (front matter) and text after it. */
function parse(md: string): { description: string; body: string } {
  const lines = md.split("\n");
  if (lines[0]?.trim() !== "---") return { description: "", body: md.trim() };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return { description: "", body: md.trim() };
  const d = lines.slice(1, end).find((l) => /^description:/.test(l)) ?? "";
  const description = d
    .slice("description:".length)
    .trim()
    .replace(/^["']|["']$/g, "");
  return {
    description: clean(description, 200),
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

/** The `.md` files in a folder, as commands named by their file (with a prefix). */
function folder(dir: string, prefix = ""): OwnCommand[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const name = `${prefix}${n.slice(0, -3)}`;
    try {
      const file = join(dir, n);
      if (!NAME.test(name) || !statSync(file).isFile() || statSync(file).size > MAX_FILE) return [];
      return [{ name, ...parse(readFileSync(file, "utf8")) }];
    } catch {
      return [];
    }
  });
}

/** Claude Code's own: yours, then each enabled plugin's (`plugin:name`). */
function claude(o: ReadOpts): OwnCommand[] {
  const plugins = readPlugins(o).filter((p) => p.agent === "claude-code" && p.path);
  return [
    ...folder(join(o.home, ".claude", "commands")),
    ...plugins.flatMap((p) => folder(join(p.path!, "commands"), `${p.name}:`)),
  ];
}

/** opencode's: its command folders, then its config's `command` table. */
function opencode(o: ReadOpts): OwnCommand[] {
  const dir = join(o.env.XDG_CONFIG_HOME || join(o.home, ".config"), "opencode");
  const files = [...folder(join(dir, "command")), ...folder(join(dir, "commands"))];
  const table = ["opencode.json", "opencode.jsonc", "config.json"]
    .map((f) => readFile(join(dir, f)))
    .find(isObj)?.command;
  const listed = isObj(table)
    ? Object.entries(table).flatMap(([name, v]) =>
        NAME.test(name) && isObj(v) && typeof v.template === "string"
          ? [
              {
                name,
                description: clean(String(v.description ?? ""), 200),
                body: v.template.slice(0, MAX_FILE),
              },
            ]
          : [],
      )
    : [];
  return [...files, ...listed];
}

/** Codex's custom prompts (`/prompts:name` in Codex). */
const codex = (o: ReadOpts) =>
  folder(join(o.env.CODEX_HOME || join(o.home, ".codex"), "prompts"), "prompts:");

const BY_AGENT: Record<string, (o: ReadOpts) => OwnCommand[]> = { "claude-code": claude, opencode, codex };

/** An agent's own commands (none for one ion can't read them for), each name once. */
export function ownCommands(agent: string, o: ReadOpts): OwnCommand[] {
  const all = BY_AGENT[agent]?.(o) ?? [];
  return all.filter((c, i) => all.findIndex((x) => x.name === c.name) === i).slice(0, MAX_COMMANDS);
}
