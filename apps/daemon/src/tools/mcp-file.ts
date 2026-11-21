import {
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { replaceFile } from "./added.js";
import { argKey, namedKey, urlHoldsKey } from "./secretish.js";

/**
 * A server from your mcp.json, as written there: values may hold `${NAME}`s or secrets you typed in, so it never
 * goes to the app, the log or an error as it is.
 */
export type McpServer =
  | { name: string; transport: "http"; url: string; headers: Record<string, string> }
  | { name: string; transport: "stdio"; command: string; args: string[]; env: Record<string, string> };

/** The servers ion uses, the ones it leaves out (and why), and why the file didn't load, if it didn't. */
export type McpRead = {
  servers: McpServer[];
  leftOut: { name: string; why: string }[];
  problem?: string;
  /** Others on this computer can read the file, and it holds a value typed in (not a `${NAME}`). */
  exposed?: true;
};

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const EMPTY = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";
const textMap = (v: unknown): v is Record<string, string> =>
  v === undefined || (isObject(v) && Object.values(v).every(isText));
const textList = (v: unknown): v is string[] => v === undefined || (Array.isArray(v) && v.every(isText));

/** Why a remote server's url can't be used, or null; a `${NAME}` in it is checked as a plain word. */
function urlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.replace(/\$\{\w+\}/g, "x"));
  } catch {
    return "Its url isn't a URL";
  }
  if (u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) return null;
  return "Use https (http only on this computer)";
}

function remote(name: string, raw: Record<string, unknown>): McpServer | string {
  if (raw.type === "sse") return "ion connects over HTTP, not SSE";
  if (!isText(raw.url)) return "Give it a command or a url";
  if (!textMap(raw.headers)) return "args, env and headers must be text";
  const why = urlProblem(raw.url);
  return why ?? { name, transport: "http", url: raw.url, headers: { ...raw.headers } };
}

function local(name: string, raw: Record<string, unknown>): McpServer | string {
  if (!isText(raw.command) || !raw.command.trim()) return "Give it a command or a url";
  if (!textList(raw.args) || !textMap(raw.env)) return "args, env and headers must be text";
  return { name, transport: "stdio", command: raw.command, args: [...(raw.args ?? [])], env: { ...raw.env } };
}

/** One entry: the server, or why it's left out (in plain words, never a value from the file). */
function serverOf(name: string, raw: unknown): McpServer | string {
  if (name.toLowerCase() === "ion") return "ion is ion's own server";
  if (!NAME.test(name)) return "Use up to 40 letters, digits, - or _";
  if (!isObject(raw)) return "Give it a command or a url";
  const isRemote =
    raw.type === "http" || raw.type === "sse" || (raw.url !== undefined && raw.command === undefined);
  return isRemote ? remote(name, raw) : local(name, raw);
}

/** JSON.parse's complaint, without the part that quotes the file (it could be a secret), and its line. */
function jsonProblem(e: unknown): string {
  const m = /^(.*?) in JSON at position \d+(?: \(line (\d+) column \d+\))?/.exec(
    String((e as Error).message),
  );
  if (!m?.[1]) return "mcp.json: not valid JSON";
  const line = m[2] ? ` (line ${m[2]})` : "";
  return `mcp.json: ${m[1]}${line}`;
}

/** Reads the file's text: the servers, or a problem (and no servers). */
export function parseMcp(text: string): McpRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { servers: [], leftOut: [], problem: jsonProblem(e) };
  }
  const entries = isObject(raw) ? raw.mcpServers : undefined;
  if (!isObject(entries))
    return { servers: [], leftOut: [], problem: "mcp.json: mcpServers must be an object" };
  const read: McpRead = { servers: [], leftOut: [] };
  for (const [name, v] of Object.entries(entries)) {
    const s = serverOf(name, v);
    if (typeof s === "string") read.leftOut.push({ name, why: s });
    else read.servers.push(s);
  }
  return read;
}

/** A value typed into the file that could be a key (asked for the readable-by-others warning). */
function holdsLiteral(s: McpServer): boolean {
  if (s.transport === "http")
    return Object.entries(s.headers).some(([k, v]) => namedKey(k, v)) || urlHoldsKey(s.url);
  return (
    Object.entries(s.env).some(([k, v]) => namedKey(k, v)) || s.args.some((a, i) => argKey(a, s.args[i - 1]))
  );
}

/** What a sign-in is for: the URL a token goes to, or the command that gets it. */
const target = (s: McpServer) => (s.transport === "http" ? s.url : JSON.stringify([s.command, s.args]));

/**
 * Your mcp.json, read each time it's asked for (the Tools page, a run's start), so a save is picked up at once.
 * Missing: created empty (only you can read it). Broken: the last good list stays, with the problem.
 * `onGone`: a server that left the file, or now points somewhere else or is left out (its sign-in must not follow
 * it); `removed`: its name is gone from the file altogether (its keys go too).
 */
export class McpFile {
  private last: McpRead = { servers: [], leftOut: [] };
  private seen: Map<string, McpServer> | null = null;
  private out = new Set<string>();

  constructor(
    readonly path: string,
    private readonly opts: { onGone?: (was: McpServer, removed: boolean) => void } = {},
  ) {}

  read(): McpRead {
    this.create();
    let r: McpRead;
    try {
      r = parseMcp(readFileSync(this.path, "utf8"));
    } catch {
      r = { servers: [], leftOut: [], problem: "mcp.json: ion can't read it" };
    }
    if (r.problem) return { ...this.last, problem: r.problem };
    this.notice(r);
    this.last = r;
    return this.othersCanRead() && r.servers.some(holdsLiteral) ? { ...r, exposed: true } : r;
  }

  private create(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    let fd: number;
    try {
      // Created only if it isn't there (one step, no check-then-write); set to 0600 through the open file.
      fd = openSync(this.path, "wx", 0o600);
    } catch {
      return; // There already (or ion can't write there): reading it says which.
    }
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, EMPTY);
    } finally {
      closeSync(fd);
    }
  }

  private othersCanRead(): boolean {
    try {
      return (statSync(this.path).mode & 0o077) !== 0;
    } catch {
      return false;
    }
  }

  private notice(r: McpRead): void {
    const now = new Map(r.servers.map((s) => [s.name, s]));
    const named = new Set([...now.keys(), ...r.leftOut.map((l) => l.name)]);
    const out = new Set(r.leftOut.map((l) => l.name));
    for (const [name, was] of this.seen ?? []) {
      const s = now.get(name);
      const told = this.out.has(name) && out.has(name); // still left out: said already
      if (!told && (!s || target(s) !== target(was))) this.opts.onGone?.(was, !named.has(name));
    }
    // A server left out for now is still yours: remembered as it was, so its removal later is seen.
    for (const name of out) {
      const was = this.seen?.get(name);
      if (was) now.set(name, was);
    }
    this.seen = now;
    this.out = out;
  }
}

/** An entry as `ion mcp add` writes it, in the standard shape (no type for a local one). */
export type McpEntry =
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { command: string; args?: string[]; env?: Record<string, string> };

/** The file's JSON for a change: everything in it (other keys too), and how it's indented. */
function forEdit(path: string): {
  raw: Record<string, unknown>;
  servers: Record<string, unknown>;
  indent: string;
} {
  let text = EMPTY;
  let raw: unknown;
  try {
    if (existsSync(path)) text = readFileSync(path, "utf8");
    raw = JSON.parse(text);
  } catch {
    throw new Error("mcp.json can't be read; fix it first");
  }
  if (!isObject(raw) || (raw.mcpServers !== undefined && !isObject(raw.mcpServers)))
    throw new Error("mcp.json: mcpServers must be an object");
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  return { raw, servers: (raw.mcpServers as Record<string, unknown> | undefined) ?? {}, indent };
}

/** Writes the whole file anew (only you can read it), swapped in at once so ion never reads half of it. */
function save(path: string, raw: Record<string, unknown>, indent: string): void {
  replaceFile(path, `${JSON.stringify(raw, null, indent)}\n`);
}

/**
 * Adds one server to mcp.json, keeping every other entry and key as they are (and the file's indent). A name that's
 * taken or can't be used is refused; what it runs is checked as ion reads it.
 */
export function addServer(path: string, name: string, entry: McpEntry): McpServer {
  const s = serverOf(name, entry);
  if (typeof s === "string") throw new Error(s);
  const { raw, servers, indent } = forEdit(path);
  if (Object.keys(servers).some((n) => n.toLowerCase() === name.toLowerCase()))
    throw new Error(`${name} is already in mcp.json`);
  save(path, { ...raw, mcpServers: { ...servers, [name]: entry } }, indent);
  return s;
}

/** Removes one server from mcp.json, keeping the rest as it is; false when it isn't there. */
export function removeServer(path: string, name: string): boolean {
  const { raw, servers, indent } = forEdit(path);
  if (!(name in servers)) return false;
  const rest = { ...servers };
  delete rest[name];
  save(path, { ...raw, mcpServers: rest }, indent);
  return true;
}
