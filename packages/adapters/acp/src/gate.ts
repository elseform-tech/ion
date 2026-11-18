import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

// ---- Grok Build: a PreToolUse HTTP hook in the chat's worktree -------------------------------------------

const GROK_HOOK = ".grok/hooks/ion.json";
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

/** The repo's shared git folder (a worktree's `.git` is a file pointing into it). */
function commonGitDir(cwd: string): string | null {
  const dotgit = join(cwd, ".git");
  if (!existsSync(dotgit)) return null;
  if (statSync(dotgit).isDirectory()) return dotgit;
  const m = /^gitdir: (.+)$/m.exec(readFileSync(dotgit, "utf8"));
  if (!m) return null;
  const gitdir = resolve(cwd, m[1]!.trim());
  const common = join(gitdir, "commondir");
  return existsSync(common) ? resolve(gitdir, readFileSync(common, "utf8").trim()) : gitdir;
}

/** Keeps ion's hook file out of git status and commits (once per repo). */
function excludeHook(cwd: string): void {
  const git = commonGitDir(cwd);
  if (!git) return;
  const file = join(git, "info", "exclude");
  const line = `/${GROK_HOOK}`;
  const now = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (now.split("\n").includes(line)) return;
  mkdirSync(join(git, "info"), { recursive: true });
  appendFileSync(file, `${now && !now.endsWith("\n") ? "\n" : ""}${line}\n`);
}

/**
 * Grok runs the worktree's hook only with folder trust off (probed 2026-11-18); a hook in ~/.grok/hooks would
 * make Grok ask for folder trust everywhere you use it yourself. The URL comes from the run's environment, so
 * the file is the same for every run. Fail closed: no answer from ion means the call is denied.
 */
export function grokGateEnv(g: GateEnv): Record<string, string> {
  mkdirSync(join(g.cwd, ".grok", "hooks"), { recursive: true });
  const hook = { type: "http", url: "${ION_GATE_URL}", timeout: 60, failClosed: true };
  writeFileSync(
    join(g.cwd, GROK_HOOK),
    `${JSON.stringify({ hooks: { PreToolUse: [{ hooks: [hook] }] } })}\n`,
  );
  excludeHook(g.cwd);
  return { ION_GATE_URL: g.url, GROK_FOLDER_TRUST: "0" };
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
  const ion = /^ion_([a-z_]+)$/.exec(tool)?.[1];
  if (ion) return call(`ion__${ion}`, "mcp", obj(p?.args) ?? {}, "ion");
  return call(tool, OPENCODE_KINDS[tool] ?? "other", obj(p?.args) ?? {});
}
