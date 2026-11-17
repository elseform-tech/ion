import { isAbsolute, relative } from "node:path";
import type { ToolKind } from "@ion/schema";

const KINDS: Record<string, ToolKind> = {
  Read: "read",
  Glob: "search",
  Grep: "search",
  LS: "search",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "command",
  BashOutput: "command",
  KillShell: "command",
  WebFetch: "web",
  WebSearch: "web",
};

export function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  return KINDS[name] ?? "other";
}

const str = (x: unknown) => (typeof x === "string" ? x : null);

/** The file a tool touches, relative to the project when under any of its roots (as given, or real path). */
function toolPath(input: Record<string, unknown>, roots: string[]): string | null {
  const p = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  if (!p) return null;
  for (const root of roots) {
    const rel = relative(root, p);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  return p;
}

/**
 * What a tool is doing: the file, the command, the pattern or the URL, on one line (newlines shown as ⏎).
 * Listings cut it at 80 characters with "…"; approvals pass `full` so nothing is hidden from the decision.
 */
export function toolSummary(
  name: string,
  input: Record<string, unknown>,
  roots: string[],
  opts: { full?: boolean } = {},
): string {
  const raw =
    toolPath(input, roots) ??
    str(input.command) ??
    str(input.pattern) ??
    str(input.url) ??
    str(input.query) ??
    name;
  const oneLine = raw
    .split("\n")
    .map((l) => l.trim())
    .join(" ⏎ ");
  if (opts.full || oneLine.length <= 80) return oneLine;
  return `${oneLine.slice(0, 79)}…`;
}

const lines = (s: unknown) => (typeof s === "string" && s.length ? s.split("\n").length : 0);

/** What a successful edit tool changed, from its input. Approximate: Write is reported as a new file. */
export function fileChange(
  name: string,
  input: Record<string, unknown>,
  roots: string[],
): { path: string; change: "add" | "modify"; added: number | null; removed: number | null } | null {
  const path = toolPath(input, roots);
  if (!path) return null;
  if (name === "Write") return { path, change: "add", added: lines(input.content), removed: null };
  if (name === "Edit")
    return { path, change: "modify", added: lines(input.new_string), removed: lines(input.old_string) };
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const edits = input.edits as Record<string, unknown>[];
    const sum = (k: string) => edits.reduce((n, e) => n + lines(e[k]), 0);
    return { path, change: "modify", added: sum("new_string"), removed: sum("old_string") };
  }
  return { path, change: "modify", added: null, removed: null };
}
