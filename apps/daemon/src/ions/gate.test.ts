import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@ion/adapter-kit";
import { decideForIon, ionVerdict } from "./gate.js";
import { ionInstructions } from "./instructions.js";
import { WebFound } from "./web.js";
import { EV } from "@ion/schema";

// The user, 2026-11-19: ions require tools (reading, searching, running read-only commands) securely.
const ctx = { roots: ["/Users/me/proj"], home: "/Users/me", ionDirs: ["/Users/me/.ion"] };
const req = (r: Partial<ApprovalRequest>): ApprovalRequest => ({
  requestId: "r",
  toolId: "t",
  toolName: "Bash",
  kind: "command",
  summary: "",
  input: {},
  ...r,
});
const cmd = (command: string) => req({ kind: "command", input: { command } });

describe("an ion's gate", () => {
  it("an ion may read and search its project and run read-only chained commands", () => {
    expect(decideForIon(cmd("cat README.md && ls src"), ctx)).toBe("allow");
    expect(
      decideForIon(req({ toolName: "Read", kind: "read", input: { file_path: "/Users/me/proj/a.ts" } }), ctx),
    ).toBe("allow");
    expect(
      decideForIon(
        req({ toolName: "Grep", kind: "search", input: { pattern: "x", path: "/Users/me/proj/src" } }),
        ctx,
      ),
    ).toBe("allow");
  });

  it("an ion may never edit, write, install, push or reach outside", () => {
    const bad = [
      req({ toolName: "Write", kind: "edit", input: { file_path: "/Users/me/proj/a.ts", content: "x" } }),
      cmd("sed -i s/a/b/ a.ts"),
      cmd("npm install"),
      cmd("git push"),
      cmd("cat ~/.ssh/id_rsa"),
      req({ toolName: "Read", kind: "read", input: { file_path: "/etc/passwd" } }),
    ];
    for (const r of bad) expect(decideForIon(r, ctx)).toBe("deny");
  });

  it("an ion's own MCP tools are allowed and other MCP servers are denied", () => {
    const mcp = (toolName: string, mcpServer: string) => req({ kind: "mcp", toolName, mcpServer });
    expect(decideForIon(mcp("mcp__ion__projects", "ion"), ctx)).toBe("allow");
    expect(decideForIon(mcp("ion__start_thread", "ion"), ctx)).toBe("allow");
    expect(decideForIon(mcp("mcp__ion__chat_history", "ion"), ctx)).toBe("allow");
    expect(decideForIon(mcp("mcp__other__projects", "other"), ctx)).toBe("deny");
    expect(decideForIon(mcp("mcp__ion__projects", "other"), ctx)).toBe("deny");
    expect(decideForIon(mcp("mcp__ion__rm_rf", "ion"), ctx)).toBe("deny");
  });

  // The user, 2026-11-21: agents add MCP servers, skills and hooks with ion's commands; ions only read, so an ion
  // can't add one: it's refused with why, and the ion starts a thread to do it.
  it("an ion can't add (it starts a thread)", async () => {
    const adds = [
      "ion mcp add github --command npx --arg -y --arg @x/github-mcp --from io.github.x/github",
      "ion skills add notes --from https://example.com/SKILL.md",
      "ion hooks add --on run.finished --run 'say done'",
      "ion mcp remove github",
    ];
    for (const a of adds) {
      expect(decideForIon(cmd(a), ctx)).toBe("deny");
      expect(await ionVerdict(cmd(a), ctx, new WebFound())).toEqual({
        decision: "deny",
        reason: "An ion only reads; a thread does the work.",
      });
    }
  });

  // Task review, 2026-11-19: `file -C` writes a .mgc file; ions never write.
  it("denies file -C", () => {
    expect(decideForIon(cmd("file -C -m x"), ctx)).toBe("deny");
  });

  // Re-review, 2026-11-19: file's flags can write (-C in any group or prefix); it isn't worth allowing.
  it("denies file -bC", () => {
    expect(decideForIon(cmd("file -bC -m x"), ctx)).toBe("deny");
  });

  // Task review, 2026-11-19: `ask` and `report_outcome` are run tools; an ion has no run to ask or report in.
  it("denies run-only tools to an ion", () => {
    for (const t of ["ask", "report_outcome"])
      expect(decideForIon(req({ kind: "mcp", toolName: `mcp__ion__${t}`, mcpServer: "ion" }), ctx)).toBe(
        "deny",
      );
  });

  // Task review, 2026-11-19: a third-party tool arriving as kind "other" (opencode's foo_bar) is denied.
  it("denies a third-party tool of kind other", () => {
    expect(decideForIon(req({ kind: "other", toolName: "foo_bar" }), ctx)).toBe("deny");
  });
});

// The user, 2026-11-20: "can ions search the internet through their respective harness too" — "sure"; and "i see
// ions as read-only, require installing, editing, or any types of writes, they should spawn downstream threads".
describe("an ion on the web", () => {
  const web = (toolName: string, input: Record<string, unknown>) => req({ toolName, kind: "web", input });
  const PAGE = "https://nodejs.org/en/about/previous-releases";
  // Built, not written out: a public address (a CDN's) and a private one (your network's).
  const PUBLIC_IP = [104, 20, 22, 46].join(".");
  const PRIVATE_IP = [10, 0, 0, 5].join(".");
  /** A turn's web: what it found (search results, your message), and a DNS that answers `to` for every name. */
  const turnWeb = (found: string[], to = PUBLIC_IP) => ({
    found: new Set(found),
    dns: async () => [{ address: to, family: 4 }],
  });

  it("an ion can search the web", async () => {
    const searches = [
      web("WebSearch", { query: "latest node" }),
      web("web_search", { query: "latest node" }),
      web("websearch", { query: "latest node" }),
    ];
    for (const r of searches) {
      expect(decideForIon(r, ctx)).toBe("allow");
      expect(await ionVerdict(r, ctx, turnWeb([]))).toEqual({ decision: "allow" });
    }
  });

  it("an ion can read a page a search returned", async () => {
    for (const name of ["WebFetch", "web_fetch", "webfetch", "fetch"])
      expect(await ionVerdict(web(name, { url: PAGE, prompt: "the version" }), ctx, turnWeb([PAGE]))).toEqual(
        {
          decision: "allow",
        },
      );
  });

  it("an ion can't read a URL it made up, a private address, or one with a long query", async () => {
    const made = await ionVerdict(web("WebFetch", { url: "https://evil.example/x" }), ctx, turnWeb([PAGE]));
    expect(made).toEqual({ decision: "deny", reason: "ion only reads pages it found or you gave it" });
    const inside = "https://intranet.example/admin";
    const priv = await ionVerdict(web("WebFetch", { url: inside }), ctx, turnWeb([inside], PRIVATE_IP));
    expect(priv.decision).toBe("deny");
    const local = "https://127.0.0.1/";
    expect((await ionVerdict(web("WebFetch", { url: local }), ctx, turnWeb([local]))).decision).toBe("deny");
    const plain = "https://nodejs.org/".replace("https:", "http:");
    expect((await ionVerdict(web("WebFetch", { url: plain }), ctx, turnWeb([plain]))).decision).toBe("deny");
    const long = `https://nodejs.org/?q=${"a".repeat(120)}`;
    expect((await ionVerdict(web("WebFetch", { url: long }), ctx, turnWeb([long]))).decision).toBe("deny");
  });

  // Task 7 ruling, 2026-11-20: a long query could carry what an ion read out to a page; at most 100 characters.
  it("a fetch with a long query is refused", async () => {
    const ok = `https://nodejs.org/dist/?q=${"a".repeat(98)}`;
    expect((await ionVerdict(web("WebFetch", { url: ok }), ctx, turnWeb([ok]))).decision).toBe("allow");
    const long = `https://nodejs.org/dist/?q=${"a".repeat(99)}`;
    expect(await ionVerdict(web("WebFetch", { url: long }), ctx, turnWeb([long]))).toEqual({
      decision: "deny",
      reason: "That address's query is too long for ion to read",
    });
  });

  it("an ion can't install, edit, send or write — it starts a thread", async () => {
    const bad = [
      req({
        toolName: "Write",
        kind: "edit",
        input: { file_path: "/Users/me/proj/README.md", content: "x" },
      }),
      cmd("npm install left-pad"),
      cmd("brew install jq"),
      cmd("curl -X POST https://api.example.com/send -d hi"),
      cmd("git commit -m x"),
      req({ kind: "mcp", toolName: "mcp__slack__send_message", mcpServer: "slack" }),
      web("WebFetch", { url: PAGE, method: "POST" }),
    ];
    for (const r of bad) expect((await ionVerdict(r, ctx, turnWeb([PAGE]))).decision).toBe("deny");
    for (const id of ["chief", "storefront"])
      expect(ionInstructions(id)).toContain(
        "You only read: anything that installs, edits, sends or writes is a thread in that project (start_thread).",
      );
  });
});

describe("an ion's web calls, recognised or refused", () => {
  const web = (toolName: string, input: Record<string, unknown>, kind = "web") =>
    req({ toolName, kind, input });
  const PAGE = "https://nodejs.org/en/about/previous-releases";
  const PUBLIC_IP = [104, 20, 22, 46].join(".");
  const turnWeb = (found: string[]) => ({
    found: new Set(found),
    dns: async () => [{ address: PUBLIC_IP, family: 4 }],
  });
  const verdict = async (r: ApprovalRequest, found: string[] = [PAGE]) =>
    (await ionVerdict(r, ctx, turnWeb(found))).decision;

  // Security review, 2026-11-21: a web call ion didn't recognise as a search was allowed when it had no `url` field
  // (an address under another key, or a tool ion doesn't know, went through unchecked).
  it("allows only a recognised search; a web call with an address anywhere is a page read; others are refused", async () => {
    expect(await verdict(web("WebSearch", { query: "latest node" }))).toBe("allow");
    // Grok's own search, as its adapter names it.
    expect(await verdict(web("web_search", { variant: "WebSearch", backend: true }))).toBe("allow");
    expect(await verdict(web("fetch", { query: "latest node" }))).toBe("deny");
    expect(await verdict(web("browse", {}))).toBe("deny");
    const other = web("browse", { url: "https://made.up/x" });
    expect(await verdict(other)).toBe("deny");
    expect(await verdict(other, ["https://made.up/x"])).toBe("allow");
    // Task review, 2026-11-21: an address under a key ion doesn't know isn't read.
    expect(
      await verdict(web("browse", { args: { target: "https://made.up/x" } }), ["https://made.up/x"]),
    ).toBe("deny");
    expect(await verdict(web("WebFetch", { prompt: "x" }))).toBe("deny");
    expect(decideForIon(web("fetch", { query: "latest node" }), ctx)).toBe("deny");
  });

  // Security review, 2026-11-21: a step guessed to be a search (no "url" in its input) fed its output into the
  // addresses an ion may read; only a step ion recognises as a search does now.
  it("only a recognised search's results become pages an ion may read", () => {
    const f = new WebFound(null);
    const step = (toolId: string, name: string, input: string) =>
      f.note({ type: EV.toolStarted, data: { toolId, name, kind: "web", summary: "", input } });
    const out = (toolId: string, text: string) => f.note({ type: EV.toolOutput, data: { toolId, text } });
    step("a", "fetch", '{"query":"x"}');
    out("a", "https://guessed.example/a");
    step("b", "web_search", '{"variant":"WebSearch","backend":true}');
    out("b", "https://grok.example/b");
    // Security review, 2026-11-21: a step's own input saying it's a search doesn't make it one.
    step("c", "search", '{"variant":"WebSearch"}');
    out("c", "https://variant.example/c");
    f.note({ type: EV.toolStarted, data: { toolId: "d", name: "web_search", kind: "other", summary: "" } });
    out("d", "https://other-kind.example/d");
    expect(f.found.has("https://guessed.example/a")).toBe(false);
    expect(f.found.has("https://grok.example/b")).toBe(true);
    expect(f.found.has("https://variant.example/c")).toBe(false);
    expect(f.found.has("https://other-kind.example/d")).toBe(false);
  });

  // Security review, 2026-11-21: a search query and a page's path were unbounded: either could carry what an ion
  // read out to a search provider or a site.
  it("a search stays short and plain, and so does a page's address", async () => {
    expect(await verdict(web("WebSearch", { query: "a ".repeat(100) }))).toBe("allow");
    expect(await verdict(web("WebSearch", { query: "a".repeat(201) }))).toBe("deny");
    expect(await verdict(web("WebSearch", { query: `node ${"QUJD".repeat(10)}` }))).toBe("deny");
    expect(await verdict(web("websearch", { query: `node ${"ab12".repeat(10)}` }))).toBe("deny");
    const long = `https://nodejs.org/${"a/".repeat(150)}`;
    expect(await verdict(web("WebFetch", { url: long }), [long])).toBe("deny");
    const ok = `https://nodejs.org/${"a/".repeat(100)}`;
    expect(await verdict(web("WebFetch", { url: ok }), [ok])).toBe("allow");
  });

  // Security review, 2026-11-21: only a top-level `method` was checked; a body, headers or a nested method could
  // turn a page read into a send.
  it("a page read with a body, headers or another method is refused", async () => {
    const bad = [
      { url: PAGE, body: "x" },
      { url: PAGE, data: { a: 1 } },
      { url: PAGE, options: { payload: "x" } },
      { url: PAGE, headers: { Cookie: "x" } },
      { url: PAGE, options: { method: "POST" } },
      { url: PAGE, httpMethod: "PUT" },
    ];
    for (const input of bad) expect(await verdict(web("WebFetch", input))).toBe("deny");
    // Task review, 2026-11-21: a page read takes only url, prompt, format and timeout.
    expect(await verdict(web("WebFetch", { url: PAGE, options: { method: "get" } }))).toBe("deny");
    expect(await verdict(web("webfetch", { url: PAGE, format: "markdown", timeout: 30 }))).toBe("allow");
    expect(await verdict(web("WebFetch", { url: PAGE, extra: "x" }))).toBe("deny");
  });

  // Security review, 2026-11-21: the call's own input ({variant: "WebSearch"}) chose the search branch, so a page read
  // could call itself a search and skip every page check. Only ion (its tool name) decides what's a search.
  it("a page read whose input says it's a search is still checked as a page read", async () => {
    const r = web("WebFetch", { url: "https://evil.example/x", variant: "WebSearch" });
    expect(await verdict(r)).toBe("deny");
    expect(decideForIon(r, ctx)).toBe("deny");
    expect(await verdict(web("browse", { variant: "WebSearch", query: "x" }))).toBe("deny");
  });

  // Security review, 2026-11-21: addresses were picked out of text by a pattern, so text around a found address (or
  // an address hidden in user info) passed as that address.
  it("a page read's address is the whole field, parsed, never a piece of text", async () => {
    const found = ["https://found.example/a?x"];
    const read = (url: string) => verdict(web("WebFetch", { url }), found);
    expect(await read("https://found.example/a?x")).toBe("allow");
    expect(await read("https://found.example/a?x evil")).toBe("deny");
    expect(await read("https://found.example@evil.example/")).toBe("deny");
    expect(await read(" https://found.example/a?x")).toBe("deny");
    // Task review, 2026-11-21: a prompt is a question about the page, never fetched; only one that is itself an
    // address is checked as one.
    expect(
      await verdict(web("WebFetch", { url: found[0], prompt: `then https://evil.example/` }), found),
    ).toBe("allow");
  });

  // Security review, 2026-11-21: an address too deep to scan, or a host given without "https://", went unchecked.
  it("a page read with an address ion can't check is refused", async () => {
    const found = ["https://found.example/a"];
    let deep: Record<string, unknown> = { url: "https://evil.example/" };
    for (let i = 0; i < 12; i++) deep = { x: deep };
    expect(await verdict(web("browse", { url: found[0], deep }), found)).toBe("deny");
    expect(await verdict(web("browse", { url: found[0], target: "evil.example" }), found)).toBe("deny");
    expect(await verdict(web("browse", { url: found[0], prompt: "the version" }), found)).toBe("allow");
  });

  // Task review, 2026-11-21: Bash and Write calls whose input said {variant: "WebSearch"} were allowed as searches.
  it("a Bash call that says it's a search is still a command", async () => {
    const r = req({
      toolName: "Bash",
      kind: "command",
      input: { command: "rm -rf /", variant: "WebSearch" },
    });
    expect(await verdict(r)).toBe("deny");
    expect(decideForIon(r, ctx)).toBe("deny");
  });

  it("a Write call that says it's a search is still a write", async () => {
    const input = { file_path: "/Users/me/proj/a.ts", content: "x", variant: "WebSearch" };
    const r = req({ toolName: "Write", kind: "edit", input });
    expect(await verdict(r)).toBe("deny");
    expect(decideForIon(r, ctx)).toBe("deny");
  });

  // Task review, 2026-11-21: addresses written another way (upper case, backslashes, one slash) slipped past the
  // scan while `prompt` held a found address.
  it("an address written in upper case, with backslashes or one slash is checked like any other", async () => {
    for (const url of [
      "HTTPS://evil.example/x",
      "https:\\\\evil.example/x",
      "https:\\169.254.169.254/",
      "https:/169.254.169.254/",
    ])
      expect(await verdict(web("WebFetch", { url, prompt: PAGE }))).toBe("deny");
    expect(await verdict(web("WebFetch", { url: "HTTPS://NODEJS.ORG/en/about/previous-releases" }))).toBe(
      "allow",
    );
  });

  // Task review, 2026-11-21: found addresses lost their trailing punctuation, so a page that differs by it passed.
  it("a found address is kept exactly as written", () => {
    const f = new WebFound("see https://found.example/a.");
    expect(f.found.has("https://found.example/a.")).toBe(true);
    expect(f.found.has("https://found.example/a")).toBe(false);
  });

  // Task 7 live check on opencode, 2026-11-21: its page read's permission request carries ACP's `locations: []`
  // beside the address, and was refused as a key ion didn't know.
  it("a page read with no locations, as an ACP agent asks, is read", async () => {
    const input = { url: PAGE, format: "text", locations: [] };
    expect(await verdict(web("fetch", input))).toBe("allow");
    expect(await verdict(web("fetch", { ...input, locations: ["/etc/passwd"] }))).toBe("deny");
  });

  // Task review, 2026-11-21: "Summary: …" and "Note: …" looked like an address (a scheme) and were refused.
  it("a page read takes an ordinary question, and still checks a prompt that is an address", async () => {
    expect(await verdict(web("WebFetch", { url: PAGE, prompt: "Summary: the latest version" }))).toBe(
      "allow",
    );
    expect(await verdict(web("webfetch", { url: PAGE, format: "markdown" }))).toBe("allow");
    expect(await verdict(web("WebFetch", { url: PAGE, prompt: "HTTPS://evil.example/" }))).toBe("deny");
    expect(await verdict(web("WebFetch", { url: PAGE, prompt: "file:///etc/passwd" }))).toBe("deny");
  });
});

// Task review, 2026-11-21: a call is let on to ion's gateway only when its name is one of the turn's servers and
// no server of the agent's own could have that name (Grok loads its own config.toml servers too).
describe("an ion's call on a server", () => {
  const mcp = (toolName: string, mcpServer?: string) =>
    req({ toolName, kind: "mcp", input: {}, ...(mcpServer ? { mcpServer } : {}) });
  it("goes on for a served server, never for one the agent has of its own", () => {
    expect(decideForIon(mcp("notes__search"), ctx, ["notes"])).toBe("allow");
    expect(decideForIon(mcp("notes__search"), ctx, ["notes"], ["notes"])).toBe("deny");
    expect(decideForIon(mcp("a__b__c"), ctx, ["a"], ["a__b"])).toBe("deny");
    expect(decideForIon(mcp("search", "notes"), ctx, ["notes"], ["notes"])).toBe("deny");
  });
});
