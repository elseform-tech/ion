import type { AdapterEvent, ApprovalRequest } from "@ion/adapter-kit";
import { EV } from "@ion/schema";
import { type Net, vet } from "../secrets/oauth-net.js";

export type Verdict = { decision: "allow" } | { decision: "deny"; reason: string };

/**
 * What a turn may read on the web: the addresses it found (its searches' results, and your message), and how names
 * are looked up (the computer's DNS; tests give their own).
 */
export type TurnWeb = { found: Set<string>; dns: Net["dns"] };

const NOT_FOUND = "ion only reads pages it found or you gave it";
const LONG_QUERY = "That address's query is too long for ion to read";
const LONG_ADDRESS = "That address is too long for ion to read";
const NOT_PUBLIC = "ion only reads public pages over https";
const ONLY_READ = "ion only reads a page by its address";
const LONG_SEARCH = "That search is too long or holds encoded text";
const QUERY_MAX = 100;
/** A page's path, query and fragment together. */
const ADDRESS_MAX = 300;
/** Each text a search is given. */
const SEARCH_MAX = 200;
/** A run of base64 or hex this long in a search is encoded data, not words. */
const BLOB_MIN = 40;

/**
 * Each agent's web search, by the name its harness (or ion's adapter, for Grok's and opencode's own steps) gives
 * it: Claude Code, Grok and Codex, opencode.
 */
const SEARCHES = new Set(["WebSearch", "web_search", "websearch"]);
/** Each agent's page-reading tool: Claude Code, Grok, opencode. */
const FETCHES = new Set(["WebFetch", "web_fetch", "webfetch"]);
/** What a page read may be given: Claude Code's (url, prompt), opencode's (url, format, timeout). */
const PAGE_KEYS = new Set(["url", "prompt", "format", "timeout"]);
/** The schemes a text must parse to (as a URL) to count as an address: checked as one. */
const SPECIAL = new Set(["http:", "https:", "ftp:", "ws:", "wss:", "file:"]);

/**
 * A call ion recognises as a web search: a search tool by its name, as the harness (or ion's adapter) gave it. The
 * call's input never decides: an agent writes that.
 */
export const isWebSearch = (r: { toolName: string }): boolean => SEARCHES.has(r.toolName);

/** A call that is a web call whatever kind its harness gave it: a web tool by name. */
export const isWebNamed = (r: { toolName: string }): boolean =>
  SEARCHES.has(r.toolName) || FETCHES.has(r.toolName);

/** Every text in an input, down to 8 levels; null when it goes deeper (it can't all be checked). */
function textsOf(v: unknown, out: string[] = [], depth = 0): string[] | null {
  if (depth > 8) return null;
  let kids: unknown[] = [];
  if (Array.isArray(v)) kids = v;
  else if (v && typeof v === "object") kids = Object.values(v);
  if (typeof v === "string") out.push(v);
  for (const x of kids) if (!textsOf(x, out, depth + 1)) return null;
  return out;
}

/** Whether a text holds encoded data: a run of BLOB_MIN or more base64 or hex characters. */
const holdsBlob = (t: string) => t.split(/[^A-Za-z0-9+/=_]/).some((w) => w.length >= BLOB_MIN);

/** A search: every text it's given short and plain (no encoded data to carry out). */
export function searchVerdict(input: Record<string, unknown>): Verdict {
  const texts = textsOf(input);
  const bad = !texts || texts.some((t) => t.length > SEARCH_MAX || holdsBlob(t));
  return bad ? { decision: "deny", reason: LONG_SEARCH } : { decision: "allow" };
}

/** The URL, if a page read may go there: https, nothing hidden in it, a short address; else why not. */
function checked(raw: string): URL | string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return NOT_FOUND;
  }
  if (u.protocol !== "https:" || u.username || u.password) return NOT_PUBLIC;
  if (u.search.length - 1 > QUERY_MAX) return LONG_QUERY;
  if (u.pathname.length + u.search.length + u.hash.length > ADDRESS_MAX) return LONG_ADDRESS;
  return u;
}

/**
 * One address: its whole text (nothing around it, not even a space) parsed as a URL, https, short, found this turn
 * (its normalised form exactly), and on a host whose every address is public.
 */
async function addressVerdict(raw: string, web: TurnWeb): Promise<string | null> {
  if (/\s/.test(raw)) return NOT_FOUND;
  const u = checked(raw);
  if (typeof u === "string") return u;
  if (!web.found.has(u.href)) return NOT_FOUND;
  const net: Net = { dns: web.dns, send: () => Promise.reject(new Error("ion doesn't fetch here")) };
  return vet(net, u, { local: false }).then(
    () => null,
    () => NOT_PUBLIC,
  );
}

/**
 * A prompt or format that is itself an address: it parses as a URL with a special scheme (in any case, with
 * backslashes or one slash). A question about the page ("Summary: …") isn't: it is never fetched.
 */
const looksLikeAddress = (t: string) => SPECIAL.has(URL.parse(t.trim())?.protocol ?? "");

/** A page read's addresses: its `url`, and any other text that looks like one; null when its input isn't one. */
function addressesOf(given: Record<string, unknown>): string[] | null {
  // An ACP agent's request adds the files it touches (`locations`): a page read touches none.
  const { locations, ...input } = given;
  if (locations !== undefined && !(Array.isArray(locations) && locations.length === 0)) return null;
  if (Object.keys(input).some((k) => !PAGE_KEYS.has(k))) return null;
  const { url, prompt, format, timeout } = input;
  if (typeof url !== "string" || (timeout !== undefined && typeof timeout !== "number")) return null;
  const texts = [prompt, format].filter((t) => t !== undefined);
  if (texts.some((t) => typeof t !== "string")) return null;
  return [url, ...(texts as string[]).filter(looksLikeAddress)];
}

/**
 * Any web call that isn't a recognised search is a page read: only `url`, `prompt`, `format` and `timeout` (nothing
 * it could send), a `url`, and every address in it https, found this turn, short (a query of at most 100
 * characters, an address of at most 300) and on a public host.
 */
export async function fetchVerdict(req: Pick<ApprovalRequest, "input">, web: TurnWeb): Promise<Verdict> {
  const addresses = addressesOf(req.input);
  if (!addresses) return { decision: "deny", reason: ONLY_READ };
  for (const raw of addresses) {
    const why = await addressVerdict(raw, web);
    if (why) return { decision: "deny", reason: why };
  }
  return { decision: "allow" };
}

/** Every https address in a text, exactly as written (each normalised as a URL), for the pages a turn found. */
function addressesIn(text: string): string[] {
  return [...text.matchAll(/https:\/\/[^\s<>"'`()[\]{}\\|^]+/g)].flatMap((m) => {
    try {
      return [new URL(m[0]).href];
    } catch {
      return [];
    }
  });
}

/**
 * A turn's addresses as they come: your message's, then each recognised web search's results (its output), never
 * a page's (what a page links to isn't something it found).
 */
export class WebFound {
  readonly found = new Set<string>();
  private readonly searches = new Set<string>();

  constructor(yours: string | null) {
    this.add(yours ?? "");
  }

  /** Notes a search starting, and adds the addresses in its results. */
  note(e: AdapterEvent): void {
    const d = e.data as { toolId?: unknown; name?: unknown; kind?: unknown; text?: unknown };
    const id = typeof d.toolId === "string" ? d.toolId : "";
    if (e.type === EV.toolStarted && this.isSearch(d)) this.searches.add(id);
    else if (e.type === EV.toolOutput && this.searches.has(id)) this.add(String(d.text ?? ""));
  }

  /** A step ion recognises as a web search: kind web and a search tool's name (never its input). */
  private isSearch(d: { name?: unknown; kind?: unknown }): boolean {
    return d.kind === "web" && isWebSearch({ toolName: String(d.name ?? "") });
  }

  private add(text: string): void {
    for (const u of addressesIn(text)) this.found.add(u);
  }
}
