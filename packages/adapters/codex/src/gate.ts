import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GateCall } from "@ion/adapter-kit";

type Kind = GateCall["kind"];
const str = (x: unknown) => (typeof x === "string" ? x : null);
const obj = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null);

/** ion's hook script (plain JS, no imports from ion): sends each tool call to ion's gate, denies unless allowed. */
export const GATE_HOOK = fileURLToPath(new URL("../hook/ion-gate.mjs", import.meta.url));

/** A word for a POSIX shell: single-quoted, any single quote closed, escaped and reopened. */
const shellWord = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** The command Codex runs for ion's hook: this Node, ion's script. The gate's address comes in ION_GATE_URL. */
export function hookCommand(node = process.execPath, script = GATE_HOOK): string {
  return `${shellWord(node)} ${shellWord(script)}`;
}

/** What Codex calls a hook it was given with `-c` and the hash it trusts it by (from its `hooks/list`). */
export type HookTrust = { key: string; hash: string };

/**
 * `-c` overrides that give Codex ion's PreToolUse hook for every tool (session flags: nothing is written to your
 * Codex folder), and trust exactly that hook once its hash is known. TOML strings are JSON strings here.
 */
export function hookArgs(trust: HookTrust | null): string[] {
  const hook = `{type="command",command=${JSON.stringify(hookCommand())},timeout=300}`;
  const args = ["-c", `hooks.PreToolUse=[{matcher="*",hooks=[${hook}]}]`];
  if (trust)
    args.push(
      "-c",
      `hooks.state={${JSON.stringify(trust.key)}={trusted_hash=${JSON.stringify(trust.hash)}}}`,
    );
  return args;
}

/** The command inside Codex's `<shell> -lc '<command>'`, as the model wrote it; anything else as it is. */
export function unwrapShell(command: string): string {
  const m = /^\S+ -l?c '((?:[^']|'\\'')*)'$/.exec(command);
  return m ? m[1]!.replaceAll("'\\''", "'") : command;
}

/** Every file an apply_patch touches (added, updated, deleted, moved to), resolved against the run's folder. */
export function patchFiles(patch: string, cwd: string): string[] {
  const files = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)];
  return [...new Set(files.map((m) => resolve(cwd, m[1]!.trim())))];
}

const KINDS: Record<string, Kind> = {
  Bash: "command",
  shell: "command",
  exec_command: "command",
  write_stdin: "command",
  apply_patch: "edit",
  view_image: "read",
  web_search: "web",
};

/** A call ion's policy can read: an edit's files as `file_path` and `locations`, a read's file as `file_path`. */
function inputFor(tool: string, input: Record<string, unknown>, cwd: string): Record<string, unknown> {
  if (tool === "apply_patch") {
    const patch = str(input.command) ?? str(input.input) ?? "";
    const files = patchFiles(patch, cwd);
    // A patch ion can't read names no file: never a made-up one (the run's folder would read as inside the
    // worktree and be allowed). An edit that names no file asks.
    return files.length ? { file_path: files[0], locations: files, patch } : { patch };
  }
  const path = str(input.path);
  return KINDS[tool] === "read" && path ? { ...input, file_path: resolve(cwd, path) } : input;
}

/** Codex's PreToolUse payload (`tool_name`, `tool_input`, `cwd`) as one tool call. */
export function codexGateCall(payload: unknown): GateCall | null {
  const p = obj(payload);
  const toolName = str(p?.tool_name);
  const raw = obj(p?.tool_input);
  if (!toolName || !raw) return null;
  const mcp = /^mcp__(.+?)__./.exec(toolName)?.[1];
  const kind: Kind = mcp ? "mcp" : (KINDS[toolName] ?? "other");
  const input = inputFor(toolName, raw, str(p?.cwd) ?? process.cwd());
  const summary = str(input.command) ?? str(input.file_path) ?? str(input.query) ?? toolName;
  return { toolName, kind, summary, input, ...(mcp ? { mcpServer: mcp } : {}) };
}
