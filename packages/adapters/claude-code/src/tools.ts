import { relative } from "node:path";
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

/** The file a tool touches, relative to the working folder when inside it. */
function toolPath(input: Record<string, unknown>, cwd: string): string | null {
  const p = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  if (!p) return null;
  const rel = relative(cwd, p);
  return rel && !rel.startsWith("..") ? rel : p;
}

/** A one-line description: the file, the command, the pattern or the URL. */
export function toolSummary(name: string, input: Record<string, unknown>, cwd: string): string {
  const text =
    toolPath(input, cwd) ?? str(input.command) ?? str(input.pattern) ?? str(input.url) ?? str(input.query);
  return (text ?? name).slice(0, 80);
}

const lines = (s: unknown) => (typeof s === "string" && s.length ? s.split("\n").length : 0);

/** What a successful edit tool changed, from its input. Approximate: Write is reported as a new file. */
export function fileChange(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): { path: string; change: "add" | "modify"; added: number | null; removed: number | null } | null {
  const path = toolPath(input, cwd);
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
