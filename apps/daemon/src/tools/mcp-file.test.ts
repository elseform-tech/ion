import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpFile, parseMcp } from "./mcp-file.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "ion-mcp-")), "mcp.json");
const write = (f: string, servers: unknown) =>
  writeFileSync(f, JSON.stringify({ mcpServers: servers }, null, 2));

// Plan 18 (the user, 2026-11-20: "it is better to import custom mcp through a config file rather than on app, but
// there should be a way to access the config file"): servers come from $ION_HOME/mcp.json, the shape Claude Code and
// Cursor use.
describe("mcp.json", () => {
  it("reads servers from mcp.json in the standard shape, picks up a save, keeps the last good one when the file is broken, and creates it when missing", () => {
    const f = tmp();
    const file = new McpFile(f);
    expect(file.read()).toEqual({ servers: [], leftOut: [] });
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ mcpServers: {} });
    expect(statSync(f).mode & 0o777).toBe(0o600);

    write(f, {
      github: { command: "npx", args: ["-y", "gh-mcp"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } },
      linear: { type: "http", url: "https://mcp.linear.app/mcp" },
      local: { url: "http://localhost:3000/mcp", headers: { "X-Key": "lit" } },
    });
    expect(file.read().servers).toEqual([
      {
        name: "github",
        transport: "stdio",
        command: "npx",
        args: ["-y", "gh-mcp"],
        env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
      },
      { name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", headers: {} },
      { name: "local", transport: "http", url: "http://localhost:3000/mcp", headers: { "X-Key": "lit" } },
    ]);

    writeFileSync(f, '{\n  "mcpServers": {\n    "a": { "command": "x", "env": { "K": "s3cret" } },\n  }\n}');
    const broken = file.read();
    expect(broken.servers.map((s) => s.name)).toEqual(["github", "linear", "local"]);
    expect(broken.problem).toBe("mcp.json: Expected double-quoted property name (line 4)");

    write(f, { only: { command: "echo" } });
    expect(file.read()).toEqual({
      servers: [{ name: "only", transport: "stdio", command: "echo", args: [], env: {} }],
      leftOut: [],
    });
  });

  it("never puts what's in the file in a problem", () => {
    expect(parseMcp('s3cret{"mcpServers": {}}').problem).toBe("mcp.json: not valid JSON");
    expect(parseMcp('{"mcpServers": "s3cret"}').problem).toBe("mcp.json: mcpServers must be an object");
    expect(parseMcp("[]").problem).toBe("mcp.json: mcpServers must be an object");
  });

  it("a server named ion, a bad URL or http to a remote host is left out with a plain reason", () => {
    const r = parseMcp(
      JSON.stringify({
        mcpServers: {
          ion: { command: "x" },
          "bad name!": { command: "x" },
          web: { url: "not a url" },
          remote: { url: "http://example.com/mcp" },
          ftp: { url: "ftp://example.com/mcp" },
          old: { type: "sse", url: "https://example.com/sse" },
          empty: {},
          odd: "s3cret",
          args: { command: "x", args: [1] },
          ok: { url: "http://127.0.0.1:8080/mcp" },
        },
      }),
    );
    expect(r.servers.map((s) => s.name)).toEqual(["ok"]);
    expect(r.leftOut).toEqual([
      { name: "ion", why: "ion is ion's own server" },
      { name: "bad name!", why: "Use up to 40 letters, digits, - or _" },
      { name: "web", why: "Its url isn't a URL" },
      { name: "remote", why: "Use https (http only on this computer)" },
      { name: "ftp", why: "Use https (http only on this computer)" },
      { name: "old", why: "ion connects over HTTP, not SSE" },
      { name: "empty", why: "Give it a command or a url" },
      { name: "odd", why: "Give it a command or a url" },
      { name: "args", why: "args, env and headers must be text" },
    ]);
    expect(JSON.stringify(r.leftOut)).not.toContain("s3cret");
  });

  it("a server removed from the file, or pointed somewhere else, loses its sign-in", () => {
    const f = tmp();
    const gone: string[] = [];
    const file = new McpFile(f, { onGone: (s) => gone.push(s.name) });
    write(f, {
      a: { url: "https://a.example/mcp" },
      b: { url: "https://b.example/mcp" },
      c: { command: "x" },
    });
    file.read();
    expect(gone).toEqual([]);
    write(f, { b: { url: "https://evil.example/mcp" }, c: { command: "x" } });
    file.read();
    expect(gone).toEqual(["a", "b"]);
    // A broken save removes nothing: the last good list stays.
    writeFileSync(f, "{");
    file.read();
    expect(gone).toEqual(["a", "b"]);
    expect(existsSync(f)).toBe(true);
  });

  // Task review, 2026-11-20: a key typed into an mcp.json others can read is a key others can read; say so.
  it("says when others can read a file holding a key typed into it", () => {
    const f = tmp();
    const file = new McpFile(f);
    write(f, { a: { command: "x", env: { TOKEN: "lit" } } });
    chmodSync(f, 0o600);
    expect(file.read().exposed).toBeUndefined();
    chmodSync(f, 0o644);
    expect(file.read().exposed).toBe(true);
    write(f, { a: { command: "x", args: ["-y", "pkg"], env: { TOKEN: "${TOKEN}" } } });
    chmodSync(f, 0o644);
    expect(file.read().exposed).toBeUndefined();
    write(f, { a: { url: "https://h.example/mcp", headers: { Authorization: "Bearer lit" } } });
    chmodSync(f, 0o640);
    expect(file.read().exposed).toBe(true);
  });

  // Task review, 2026-11-20: a key in a remote server's URL counts too.
  it("counts a key in a remote server's URL", () => {
    const f = tmp();
    const file = new McpFile(f);
    for (const url of [
      "https://u:pw@h.example/mcp",
      "https://h.example/mcp/sk-ak-9fQ2xLmP4rT7vW1zY3bN/sse",
      "https://h.example/mcp?key=9fQ2xLmP4rT7vW1zY3bN",
    ]) {
      write(f, { a: { url } });
      chmodSync(f, 0o644);
      expect(file.read().exposed, url).toBe(true);
    }
    write(f, { a: { url: "https://h.example/mcp?team=${TEAM}" } });
    chmodSync(f, 0o644);
    expect(file.read().exposed).toBeUndefined();
  });

  // Task review, 2026-11-20: a malformed escape in a URL's query (%E0) threw and broke the Tools page and run start.
  it("reads a URL with a malformed escape", () => {
    const f = tmp();
    const file = new McpFile(f);
    write(f, { a: { url: "https://h.example/mcp?k=%E0" } });
    chmodSync(f, 0o644);
    expect(file.read().servers.map((s) => s.name)).toEqual(["a"]);
  });

  // Task review, 2026-11-20: the warning asked the display's redaction, so a docs URL counted and a plain setting
  // like MODE=fast did too; it asks whether a value could be a key.
  it("counts only values that could be keys", () => {
    const f = tmp();
    const file = new McpFile(f);
    const cases: [unknown, boolean][] = [
      [{ command: "x", args: ["https://example.com/docs", "localhost:3000", "-y"] }, false],
      [{ command: "x", env: { MODE: "fast", LOG_LEVEL: "debug" } }, false],
      [{ command: "x", env: { GITHUB_TOKEN: "abc" } }, true],
      [{ command: "x", env: { CONFIG: "ghp_A1b2C3d4E5f6G7h8I9j0" } }, true],
      [{ command: "x", args: ["--api-key", "plainword"] }, true],
      [{ url: "https://h.example/mcp", headers: { "X-Mode": "fast" } }, false],
      [{ url: "https://h.example/mcp", headers: { Authorization: "Bearer abc" } }, true],
    ];
    for (const [server, exposed] of cases) {
      write(f, { a: server });
      chmodSync(f, 0o644);
      expect(file.read().exposed ?? false, JSON.stringify(server)).toBe(exposed);
    }
  });
});
