import { statSync } from "node:fs";
import { type Follow, openFile } from "../tools/read-file.js";
import { isPrivate } from "./secrets.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadUserConfig } from "@ion/config";
import { type ApprovalRequest, parseJsonc } from "@ion/adapter-kit";
import { parse as parseToml } from "smol-toml";
import { commandText, under, unshell } from "./paths.js";

/**
 * Each agent's own allow and deny rules, as your decisions (the user, 2026-11-21: "use whatever the underlying harnesses
 * already does"): read from your own settings only (never a project's, which a repo writes), never written. A rule ion
 * can't match safely is left out, never widened: exact tool names, and a command's exact text or its first words.
 * `command` with neither `exact` nor `prefix` is every command (a deny only); `loose`: a deny's wildcard, read as plain
 * "starts with" (task review, 2026-11-22: the safe way).
 */
type AgentRule =
  | { kind: "command"; exact?: string; prefix?: string; loose?: true }
  | { kind: "tool"; name: string }
  | { kind: "server"; name: string };
/** One agent's rules: who they're from, its allows and denies, and lines for the judge (Codex's trust). */
export type TheirRules = { agent: string; allow: AgentRule[]; deny: AgentRule[]; notes: string[] };

/** `managed`: Claude Code's managed settings file (tests); by default where Claude Code keeps it on this system. */
type Where = { home: string; env?: NodeJS.ProcessEnv; project?: string; managed?: string };

/** Claude Code's managed settings (set by an administrator, or by you for the whole computer). */
const MANAGED =
  process.platform === "darwin"
    ? "/Library/Application Support/ClaudeCode/managed-settings.json"
    : "/etc/claude-code/managed-settings.json";

/** Spaces and tabs as one space: `git  push` is `git push` (task review, 2026-11-22). */
const oneSpace = (s: string) => s.replace(/\s+/g, " ").trim();

const MAX = 1024 * 1024;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Files read, by path, with the mtime and size they had: read again only when they change (task review, 2026-11-21). */
const read = new Map<string, { at: string; text: string | null }>();

/**
 * Where a settings file's link may lead (review of 05d5c8b, 2026-11-22): a regular .json (or .jsonc, .toml) file in
 * your home that isn't a secret (an agent's sign-in file least of all) or ion's.
 */
const settingsLinks = (home: string): Follow => ({
  root: home,
  accept: (t) => /\.(json|jsonc|toml)$/i.test(t) && !isPrivate(t, home),
});

/** A file's text: missing, too big or unreadable is nothing. */
function textOf(path: string, home: string): string | null {
  const known = read.get(path);
  // Checked and read through one open file (CodeQL, PR #25).
  // Your settings file may be a link (dotfiles): followed one hop, only to your own settings files (review).
  const f = openFile(path, MAX, known?.at, { follow: settingsLinks(home) });
  if (!f || f.kind !== "file") return null;
  if (known?.at === f.at) return known.text;
  read.set(path, { at: f.at, text: f.text });
  return f.text;
}
function jsonOf(path: string, home: string): Record<string, unknown> {
  const text = textOf(path, home);
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

/**
 * `npm test`, `npm test:*`, `npm test *`: the exact text, or its first words. A deny with any other wildcard is what
 * comes before it, as "starts with" (`git push*`, `rm -rf *.tmp`); an allow with one is null.
 */
function commandRule(pattern: string, allow: boolean): AgentRule | null {
  const p = oneSpace(pattern);
  const prefix = /^(.*?)(?::\*| \*)$/.exec(p)?.[1]?.trim();
  if (prefix !== undefined && WORDS.test(prefix)) return { kind: "command", prefix };
  if (WORDS.test(p)) return { kind: "command", exact: p };
  const lit = p.split("*")[0]!.trim();
  return !allow && p.includes("*") && WORDS.test(lit) ? { kind: "command", prefix: lit, loose: true } : null;
}

const NAME = /^[A-Za-z_][\w-]*$/;
/** Claude Code's tools that write or run: a bare allow of one would turn Auto off for all of it (Full is that switch). */
const CLAUDE_BROAD = new Set(["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** One Claude Code rule: `Bash(...)`, an exact tool, `mcp__server` (its tools); the rest (path patterns) is null. */
function claudeRule(text: string, allow: boolean): AgentRule | null {
  // Task 11, 2026-11-22: `Bash(*)`, `Edit(**)` are the bare tool; a bare deny refuses all of it, a bare allow stays out.
  const bare = /^([A-Za-z_][\w-]*)\(\s*\*+\s*\)$/.exec(text.trim())?.[1];
  if (bare) return allow ? null : namedRule(bare, false);
  return namedRule(text, allow);
}

/** `Bash(...)`, an exact tool, `mcp__server`. */
function namedRule(text: string, allow: boolean): AgentRule | null {
  const bash = /^Bash\((.+)\)$/.exec(text.trim());
  if (bash) return commandRule(bash[1]!, allow);
  const t = text.trim().replace(/__\*$/, "");
  if (!NAME.test(t)) return null;
  if (t === "Bash") return allow ? null : { kind: "command" };
  if (allow && CLAUDE_BROAD.has(t)) return null;
  const server = /^mcp__([^_].*?)$/.exec(t)?.[1];
  return server && !server.includes("__") ? { kind: "server", name: server } : { kind: "tool", name: t };
}

/**
 * Claude Code's `permissions` from your user settings (`settings.json`, and `settings.local.json` there) and its managed
 * settings.
 */
function claudeRules(w: Where): TheirRules {
  const dir = (w.env ?? process.env).CLAUDE_CONFIG_DIR || join(w.home, ".claude");
  const paths = [...["settings.json", "settings.local.json"].map((f) => join(dir, f)), w.managed ?? MANAGED];
  const files = paths.map((p) => jsonOf(p, w.home));
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
  if (pattern.trim() !== "*") return commandRule(pattern, allow);
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

/** opencode's `permission` from its global config (`$XDG_CONFIG_HOME/opencode`, `$OPENCODE_CONFIG`), never a project's. */
function opencodeRules(w: Where): TheirRules {
  const env = w.env ?? process.env;
  const dir = join(env.XDG_CONFIG_HOME || join(w.home, ".config"), "opencode");
  const out = { allow: [] as AgentRule[], deny: [] as AgentRule[] };
  const files = ["config.json", "opencode.json", "opencode.jsonc"].map((f) => join(dir, f));
  for (const f of [...files, ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : [])]) {
    const permission = jsonOf(f, w.home).permission;
    if (isObject(permission)) for (const [tool, v] of Object.entries(permission)) opencodeTool(tool, v, out);
  }
  return { agent: "opencode", ...out, notes: [] };
}

/** Codex's trusted projects: a line for the judge when this project is one, never an allow. */
function codexRules(w: Where): TheirRules {
  const dir = (w.env ?? process.env).CODEX_HOME || join(w.home, ".codex");
  let projects: Record<string, unknown> = {};
  try {
    const t = parseToml(textOf(join(dir, "config.toml"), w.home) ?? "");
    projects = isObject(t.projects) ? t.projects : {};
  } catch {
    // unreadable: no trust
  }
  const trusted = Object.entries(projects)
    .filter(([, v]) => isObject(v) && v.trust_level === "trusted")
    .map(([p]) => resolve(p));
  const here = !!w.project && trusted.some((p) => under(resolve(w.project!), p));
  const notes = here ? ["Codex trusts this project (its own setting)"] : [];
  return { agent: "Codex", allow: [], deny: [], notes };
}

/** The rules an agent's chats go by, from your own settings; null for an agent with none ion reads. */
export function readAgentRules(harness: string, w: Where): TheirRules | null {
  if (harness === "claude-code") return claudeRules(w);
  if (harness === "opencode") return opencodeRules(w);
  return harness === "codex" ? codexRules(w) : null;
}

/** How many of an agent's allow and deny rules ion goes by (Settings → Agents); Codex's trust isn't one. */
export const ruleCount = (r: TheirRules | null): number => (r ? r.allow.length + r.deny.length : 0);

/** A command's parts, each as the shell reads it: what a deny looks for anywhere in a chain. */
const partsOf = (command: string) =>
  unshell(command)
    .split(/[;&|\n\r()`]|\$\(/)
    .map(oneSpace)
    .filter(Boolean);

const startsWith = (text: string, prefix: string) => text === prefix || text.startsWith(`${prefix} `);

/** An allow: the whole command, alone (nothing chained after it). A deny: any part of it. */
function commandMatches(rule: AgentRule & { kind: "command" }, command: string, allow: boolean): boolean {
  const alone = CHAINS.test(command) ? [] : [oneSpace(command)];
  const texts = allow ? alone : partsOf(command);
  const { exact, prefix, loose } = rule;
  if (exact !== undefined) return texts.some((t) => t === exact);
  if (prefix !== undefined) return texts.some((t) => (loose ? t.startsWith(prefix) : startsWith(t, prefix)));
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

/**
 * The rules of a run's agent, with Codex's trust for the run's project folder. Your config is read again only when it
 * changes (task review, 2026-11-22); the agents' files are cached the same way. `home`: where your agents' configs are
 * (ION_AGENTS_HOME in the tour).
 */
export function theirRulesOf(configFile: string, home: string = homedir()) {
  let seen: { at: number; projects: { id: string; path: string }[] } | null = null;
  const projects = () => {
    const at = statSync(configFile, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (seen?.at !== at) seen = { at, projects: loadUserConfig(configFile).config.projects };
    return seen.projects;
  };
  return (r: { harness?: string; projectId: string }): TheirRules | null => {
    if (!r.harness) return null;
    const project = projects().find((p) => p.id === r.projectId)?.path;
    return readAgentRules(r.harness, { home, ...(project ? { project } : {}) });
  };
}
