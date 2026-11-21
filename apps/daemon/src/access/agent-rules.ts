import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { type ApprovalRequest, parseJsonc } from "@ion/adapter-kit";
import { parse as parseToml } from "smol-toml";
import { commandText, under, unshell } from "./paths.js";

/**
 * Each agent's own allow and deny rules, as your decisions (the user, 2026-11-21: "use whatever the underlying harnesses
 * already does"): read from your own settings only (never a project's, which a repo writes), never written. A rule ion
 * can't match safely is left out, never widened: exact tool names, and a command's exact text or its first words.
 * `command` with neither `exact` nor `prefix` is every command (a deny only).
 */
type AgentRule =
  | { kind: "command"; exact?: string; prefix?: string }
  | { kind: "tool"; name: string }
  | { kind: "server"; name: string };
/** One agent's rules: who they're from, its allows and denies, and lines for the judge (Codex's trust). */
export type TheirRules = { agent: string; allow: AgentRule[]; deny: AgentRule[]; notes: string[] };

type Where = { home: string; env?: NodeJS.ProcessEnv; project?: string };

const MAX = 1024 * 1024;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A file's text: missing, too big or unreadable is nothing. */
function textOf(path: string): string | null {
  try {
    return existsSync(path) && statSync(path).size <= MAX ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}
function jsonOf(path: string): Record<string, unknown> {
  const text = textOf(path);
  try {
    const v = text === null ? null : parseJsonc(text);
    return isObject(v) ? v : {};
  } catch {
    return {};
  }
}
const stringsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Shell syntax that chains, pipes, redirects or runs more: an allow never covers a command with any of it. */
const CHAINS = /[;&|<>`$()\n\r]/;
/** First words a rule can name: plain words, no shell syntax, no wildcards. */
const WORDS = /^[\w./@+=:,%~-]+(?: [\w./@+=:,%~-]+)*$/;

/** `npm test`, `npm test:*`, `npm test *`: the exact text, or its first words; anything else is null. */
function commandRule(pattern: string): AgentRule | null {
  const p = pattern.trim();
  const prefix = /^(.*?)(?::\*| \*)$/.exec(p)?.[1]?.trim();
  if (prefix !== undefined) return WORDS.test(prefix) ? { kind: "command", prefix } : null;
  return WORDS.test(p) ? { kind: "command", exact: p } : null;
}

const NAME = /^[A-Za-z_][\w-]*$/;
/** Claude Code's tools that write or run: a bare allow of one would turn Auto off for all of it (Full is that switch). */
const CLAUDE_BROAD = new Set(["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** One Claude Code rule: `Bash(...)`, an exact tool, `mcp__server` (its tools); the rest (path patterns) is null. */
function claudeRule(text: string, allow: boolean): AgentRule | null {
  const bash = /^Bash\((.+)\)$/.exec(text.trim());
  if (bash) return commandRule(bash[1]!);
  const t = text.trim().replace(/__\*$/, "");
  if (!NAME.test(t)) return null;
  if (t === "Bash") return allow ? null : { kind: "command" };
  if (allow && CLAUDE_BROAD.has(t)) return null;
  const server = /^mcp__([^_].*?)$/.exec(t)?.[1];
  return server && !server.includes("__") ? { kind: "server", name: server } : { kind: "tool", name: t };
}

/** Claude Code's `permissions` from your user settings (`settings.json`, and `settings.local.json` there). */
function claudeRules(w: Where): TheirRules {
  const dir = (w.env ?? process.env).CLAUDE_CONFIG_DIR || join(w.home, ".claude");
  const files = ["settings.json", "settings.local.json"].map((f) => jsonOf(join(dir, f)));
  const of = (key: "allow" | "deny") =>
    files.flatMap((s) => stringsOf(isObject(s.permissions) ? s.permissions[key] : undefined));
  const pick = (key: "allow" | "deny") =>
    of(key)
      .map((r) => claudeRule(r, key === "allow"))
      .filter((r): r is AgentRule => !!r);
  return { agent: "Claude Code", allow: pick("allow"), deny: pick("deny"), notes: [] };
}

/** One opencode bash pattern: `*` is every command (a deny only); `npm *` its first words; plain text exact. */
function opencodeBash(pattern: string, allow: boolean): AgentRule | null {
  if (pattern.trim() !== "*") return commandRule(pattern);
  return allow ? null : { kind: "command" };
}

/** Another opencode tool, whole: an allow of every edit is left out (Full is that switch). */
const opencodeOther = (tool: string, pattern: string, allow: boolean): AgentRule | null =>
  pattern === "*" && !(allow && tool === "edit") && NAME.test(tool) ? { kind: "tool", name: tool } : null;

/** opencode's permission for one tool: "allow", "deny" (or "ask", left to ion's judge), or bash's patterns. */
function opencodeTool(tool: string, v: unknown, out: { allow: AgentRule[]; deny: AgentRule[] }): void {
  const entries: [string, unknown][] = isObject(v) ? Object.entries(v) : [["*", v]];
  for (const [pattern, action] of entries) {
    if (action !== "allow" && action !== "deny") continue;
    const allow = action === "allow";
    const rule = tool === "bash" ? opencodeBash(pattern, allow) : opencodeOther(tool, pattern, allow);
    if (rule) out[action].push(rule);
  }
}

/** opencode's `permission` from its global config (`$XDG_CONFIG_HOME/opencode`), never a project's. */
function opencodeRules(w: Where): TheirRules {
  const dir = join((w.env ?? process.env).XDG_CONFIG_HOME || join(w.home, ".config"), "opencode");
  const out = { allow: [] as AgentRule[], deny: [] as AgentRule[] };
  for (const f of ["config.json", "opencode.json", "opencode.jsonc"]) {
    const permission = jsonOf(join(dir, f)).permission;
    if (isObject(permission)) for (const [tool, v] of Object.entries(permission)) opencodeTool(tool, v, out);
  }
  return { agent: "opencode", ...out, notes: [] };
}

/** Codex's trusted projects: a line for the judge when this project is one, never an allow. */
function codexRules(w: Where): TheirRules & { trusted: number } {
  const dir = (w.env ?? process.env).CODEX_HOME || join(w.home, ".codex");
  let projects: Record<string, unknown> = {};
  try {
    const t = parseToml(textOf(join(dir, "config.toml")) ?? "");
    projects = isObject(t.projects) ? t.projects : {};
  } catch {
    // unreadable: no trust
  }
  const trusted = Object.entries(projects)
    .filter(([, v]) => isObject(v) && v.trust_level === "trusted")
    .map(([p]) => resolve(p));
  const here = !!w.project && trusted.some((p) => under(resolve(w.project!), p));
  const notes = here ? ["Codex trusts this project (its own setting)"] : [];
  return {
    agent: "Codex",
    allow: [],
    deny: [],
    notes,
    trusted: trusted.length,
  };
}

/** The rules an agent's chats go by, from your own settings; null for an agent with none ion reads. */
export function readAgentRules(harness: string, w: Where): (TheirRules & { trusted?: number }) | null {
  if (harness === "claude-code") return claudeRules(w);
  if (harness === "opencode") return opencodeRules(w);
  return harness === "codex" ? codexRules(w) : null;
}

/** How many of an agent's rules ion goes by (Settings → Agents). */
export const ruleCount = (r: (TheirRules & { trusted?: number }) | null): number =>
  r ? r.allow.length + r.deny.length + (r.trusted ?? 0) : 0;

/** A command's parts, each as the shell reads it: what a deny looks for anywhere in a chain. */
const partsOf = (command: string) =>
  unshell(command)
    .split(/[;&|\n\r()`]|\$\(/)
    .map((p) => p.trim())
    .filter(Boolean);

const startsWith = (text: string, prefix: string) => text === prefix || text.startsWith(`${prefix} `);

/** An allow: the whole command, alone (nothing chained after it). A deny: any part of it. */
function commandMatches(rule: AgentRule & { kind: "command" }, command: string, allow: boolean): boolean {
  const alone = CHAINS.test(command) ? [] : [command.trim()];
  const texts = allow ? alone : partsOf(command);
  if (rule.exact !== undefined) return texts.some((t) => t === rule.exact);
  if (rule.prefix !== undefined) return texts.some((t) => startsWith(t, rule.prefix!));
  return !allow;
}

function matches(rule: AgentRule, req: ApprovalRequest, allow: boolean): boolean {
  if (rule.kind === "command") return req.kind === "command" && commandMatches(rule, commandText(req), allow);
  if (rule.kind === "server")
    return req.mcpServer === rule.name || req.toolName.startsWith(`mcp__${rule.name}__`);
  return req.toolName === rule.name;
}

/** What an agent's own rules say of a call: its deny wins over its allow; null when neither covers it. */
export function theirSay(
  req: ApprovalRequest,
  r: TheirRules,
): { decision: "allow" | "deny"; reason: string } | null {
  if (r.deny.some((x) => matches(x, req, false)))
    return { decision: "deny", reason: `Your ${r.agent} settings deny this` };
  if (r.allow.some((x) => matches(x, req, true)))
    return { decision: "allow", reason: `Your ${r.agent} settings allow this` };
  return null;
}
