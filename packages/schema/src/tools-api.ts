import type {
  ImportInfo,
  ImportResult,
  NewHook,
  Picks,
  RegistryHit,
  ServerTools,
  ToolAdd,
  ToolCheck,
  ToolItem,
  ToolType,
  ToolsInfo,
} from "./tools.js";

/** The commands for Settings → Tools and `ion mcp|skills|hooks` (part of Commands). */
export type ToolsCommands = {
  /** Connections from mcp.json, your hooks, and what each agent can take. */
  "tools.list": { args: Record<string, never>; result: ToolsInfo };
  /** Turns a connection, a hook or a skill on or off (kept in ion's config, never in mcp.json). */
  "tools.setOn": {
    args: { kind: "mcp" | "hook" | "skill" | "repo"; id: string; on: boolean };
    result: ToolsInfo;
  };
  /** Keeps a key for `${name}` in a server of mcp.json (`id`), in the keychain (never in config or the log). */
  "tools.setKey": { args: { id: string; name: string; key: string }; result: ToolsInfo };
  "tools.addHook": { args: NewHook; result: ToolsInfo };
  /** null clears the project (every project's events). */
  "tools.updateHook": {
    args: { id: string } & Partial<Omit<NewHook, "project">> & { project?: string | null };
    result: ToolsInfo;
  };
  "tools.removeHook": { args: { id: string }; result: ToolsInfo };
  /**
   * Starts signing in to a remote server (OAuth): the page the app opens in your browser. A server that can't
   * register ion needs a client ID (and maybe a secret, kept in the keychain).
   */
  "tools.signIn": { args: { id: string; clientId?: string; clientSecret?: string }; result: { url: string } };
  /** Forgets a remote server's sign-in (its tokens and any client secret). */
  "tools.signOut": { args: { id: string }; result: ToolsInfo };
  /** The official MCP Registry's servers for a name: how each runs, the keys it needs, its source. */
  "tools.search": { args: { query: string }; result: RegistryHit[] };
  /** Adds a connection, skill or hook, off (you turn it on in Settings → Tools); a literal key is refused. */
  "tools.add": { args: ToolAdd; result: ToolItem };
  /** Whether it's valid, where it came from, and whether it's on. */
  "tools.verify": { args: { kind: ToolType; name: string }; result: ToolCheck };
  /** Safe checks (never starting anything off); for a local server that's on, its tools. No name: every one. */
  "tools.doctor": { args: { kind: ToolType; name?: string }; result: ToolCheck[] };
  /** Removes one (a chat's agent: only what a chat added). */
  "tools.remove": { args: { kind: ToolType; name: string }; result: { ok: true } };
  /** Every connection, skill or hook of this kind, on or off, with where it came from. */
  "tools.items": { args: { kind: ToolType }; result: ToolItem[] };
  /** The servers in your agents' own configs that aren't in mcp.json (read only now; nothing is run or contacted). */
  "tools.importable": { args: Record<string, never>; result: ImportInfo };
  /** Adds them to mcp.json, off, keys left out as `${NAME}`s: one agent's, these names, or every one listed. */
  /** `repo`: a project's own file (`shop:.mcp.json`): its servers come in only when it's named. */
  "tools.import": { args: { agent?: string; names?: string[]; repo?: string }; result: ImportResult };
  /** Hides the Import line (one agent's, or every one) until a server ion hasn't seen appears. */
  "tools.dismissImport": { args: { agent?: string }; result: ImportInfo };
  /**
   * What "/" and "@" list in a message box (the user, 2026-11-21): a chat's agent's own skills and commands and ion's
   * that reach it, and its servers; for an ion's chat (`ionId`), the skills and servers that ion's threads can use.
   */
  "tools.picks": {
    args: { harness?: string; chatId?: string; projectId?: string | null; ionId?: string };
    result: Picks;
  };
  /** A server's tools (from its tools/list; only one that's on), each with whether ions can use it. */
  "tools.serverTools": { args: { id: string }; result: ServerTools };
  /** "Ions can use" for one of a server's tools: your switch, kept with what the tool is now. */
  "tools.setIonUse": { args: { id: string; tool: string; on: boolean }; result: { ok: true } };
};
