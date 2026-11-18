import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GateCall } from "@ion/adapter-kit";

/** Where a run's gate is: its URL, and the worktree the harness runs in. */
export type GateEnv = { url: string; cwd: string };

type Kind = GateCall["kind"];
const str = (x: unknown) => (typeof x === "string" ? x : null);
const obj = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null);

/** A file tool's input with its file under `file_path`, whatever the harness calls it, for policy and rules. */
function withFilePath(input: Record<string, unknown>): Record<string, unknown> {
  if (str(input.file_path)) return input;
  const p = ["filePath", "path", "target_file", "target_notebook", "file"]
    .map((k) => str(input[k]))
    .find(Boolean);
  return p ? { ...input, file_path: p } : input;
}

function call(toolName: string, kind: Kind, input: Record<string, unknown>, mcpServer?: string): GateCall {
  const file = kind === "read" || kind === "edit" ? withFilePath(input) : input;
  const summary =
    str(input.command) ??
    str(file.file_path) ??
    str(input.url) ??
    str(input.pattern) ??
    str(input.query) ??
    toolName;
  return { toolName, kind, summary, input: file, ...(mcpServer ? { mcpServer } : {}) };
}

// ---- Grok Build: a PreToolUse hook in your Grok folder that acts only in ion's runs -------------------------

const GROK_HOOK = "ion-gate.json";
const GROK_KINDS: Record<string, Kind> = {
  run_terminal_command: "command",
  read_file: "read",
  hashline_read: "read",
  search_replace: "edit",
  hashline_edit: "edit",
  write: "edit",
  write_file: "edit",
  grep: "search",
  list_dir: "search",
  glob: "search",
  web_fetch: "web",
  web_search: "web",
};

/**
 * Outside ion's runs (no ION_GATE_URL) it does nothing; in them it sends the call to ion and prints ion's
 * answer. curl failing (ion down, a 400) is a failed hook, and failClosed makes that a deny.
 */
const GROK_COMMAND =
  '[ -z "$ION_GATE_URL" ] && exit 0; curl -sf --max-time 60 -H "content-type: application/json" --data-binary @- "$ION_GATE_URL"';

/**
 * Grok's hook lives in your Grok folder (`$GROK_HOME/hooks`, else `~/.grok/hooks`), written once. A hook in the
 * worktree would need folder trust off, and that would also load a repo's own Grok hooks and MCP servers unasked.
 * Trade-off (probed 2026-11-18): with any hook of your own, Grok asks for folder trust in folders you use it in.
 */
export function grokGateEnv(g: GateEnv): Record<string, string> {
  const dir = join(process.env.GROK_HOME ?? join(homedir(), ".grok"), "hooks");
  const hook = { type: "command", command: GROK_COMMAND, timeout: 60, failClosed: true };
  const body = `${JSON.stringify({ hooks: { PreToolUse: [{ hooks: [hook] }] } })}\n`;
  // Written on every gated start (same content), never checked first: nothing to race between check and write.
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, GROK_HOOK), body);
  return { ION_GATE_URL: g.url };
}

/** Grok's PreToolUse payload. A cut-off input could hide the end of a command, so it isn't read (deny). */
export function grokToCall(payload: unknown): GateCall | null {
  const p = obj(payload);
  const toolName = str(p?.toolName);
  const input = obj(p?.toolInput);
  if (!toolName || !input || p?.toolInputTruncated !== false) return null;
  const mcp = /^(.+?)__./.exec(toolName)?.[1];
  if (mcp) return call(toolName, "mcp", input, mcp);
  return call(toolName, GROK_KINDS[toolName] ?? "other", input);
}

// ---- opencode: ion's plugin, loaded through ion's own inline config ---------------------------------------

/** The plugin file ion ships (plain JS, no imports), as a file URL for opencode's `plugin` list. */
export const OPENCODE_PLUGIN = new URL("../plugin/ion-gate.js", import.meta.url).href;
// Fails loudly at load if the file isn't shipped, rather than running opencode without its gate.
fileURLToPath(OPENCODE_PLUGIN);

const OPENCODE_KINDS: Record<string, Kind> = {
  bash: "command",
  read: "read",
  edit: "edit",
  write: "edit",
  patch: "edit",
  multiedit: "edit",
  glob: "search",
  grep: "search",
  list: "search",
  webfetch: "web",
  websearch: "web",
};

/** The plugin's `{tool, args}`. MCP tools (`<server>_<tool>`) can't be told apart from others: "other". */
export function opencodeToCall(payload: unknown): GateCall | null {
  const p = obj(payload);
  const tool = str(p?.tool);
  if (!tool) return null;
  // ion's own MCP server is "ion", so its tools come as ion_<tool>; other servers' tools stay "other".
  const ion =
    /^ion_(chat_history|search_chats|open_needs|memory_list|memory_write|ask|decisions|report_outcome)$/.exec(
      tool,
    )?.[1];
  if (ion) return call(`ion__${ion}`, "mcp", obj(p?.args) ?? {}, "ion");
  return call(tool, OPENCODE_KINDS[tool] ?? "other", obj(p?.args) ?? {});
}
