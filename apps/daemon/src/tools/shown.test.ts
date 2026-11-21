import { describe, expect, it } from "vitest";
import { shownArgs, shownCommand, shownHost } from "./shown.js";

// Task review, 2026-11-20: secrets typed into mcp.json reached the app through the url and the command's arguments
// (a database password, a token after -e, an Authorization header, a key in a URL's path, a password with an @).
describe("what the app sees of a server", () => {
  it("shows only a remote server's host", () => {
    expect(shownHost("https://user:p@ss@host.example/mcp")).toBe("host.example");
    expect(shownHost("https://actions.zapier.com/mcp/sk-ak-9fQ2xLmP4rT7vW1zY3bN/sse")).toBe(
      "actions.zapier.com",
    );
    expect(shownHost("http://localhost:3000/mcp?key=s3cret")).toBe("localhost:3000");
    expect(shownHost("https://${HOST}/mcp")).toBe("${HOST}");
  });

  it("shows a command's name and its arguments without their secrets", () => {
    expect(shownCommand("/usr/local/bin/npx")).toBe("npx");
    const args = [
      "-y",
      "@modelcontextprotocol/server-postgres",
      "postgresql://u:pass@db.example/app",
      "-e",
      "GITHUB_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0",
      "--header",
      "Authorization: Bearer ghp_A1b2C3d4E5f6G7h8I9j0",
      "https://actions.zapier.com/mcp/sk-ak-9fQ2xLmP4rT7vW1zY3bN/sse",
      "sk-ak-9fQ2xLmP4rT7vW1zY3bN",
      "--api-key",
      "plainword",
      "--token=${GH}",
      "my-server-name",
    ];
    const shown = shownArgs(args);
    expect(shown).toEqual([
      "-y",
      "@modelcontextprotocol/server-postgres",
      "db.example",
      "-e",
      "GITHUB_TOKEN=…",
      "--header",
      "Authorization: …",
      "actions.zapier.com",
      "…",
      "--api-key",
      "…",
      "--token=${GH}",
      "my-server-name",
    ]);
    for (const secret of ["pass", "ghp_", "sk-ak", "plainword"])
      expect(JSON.stringify(shown)).not.toContain(secret);
  });

  // Task review, 2026-11-20: "Authorization:Bearer x" (no space), JWTs and base64 keys still showed.
  it("hides a header with no space, and tokens with dots, slashes, pluses or equals", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcDEF123_xyz";
    const b64 = "dGhpcyBpcyBhIHNlY3JldCBrZXk+Lw9Q==";
    expect(
      shownArgs(["Authorization:Bearer x", "X-Api-Key:sk_live_1", jwt, b64, "pkg@1.2.3", "src/index.ts"]),
    ).toEqual(["Authorization: …", "X-Api-Key: …", "…", "…", "pkg@1.2.3", "src/index.ts"]);
    expect(shownArgs([`--key=${b64}`, "dGhpcyBpcyBhIHNlY3JldA2=="])).toEqual(["--key=…", "…"]);
  });

  // Task review, 2026-11-20: a host and port isn't a header.
  it("shows host:port as it is", () => {
    expect(
      shownArgs(["localhost:3000", "127.0.0.1:8080", "db.local:5432", "Authorization:Bearer x"]),
    ).toEqual(["localhost:3000", "127.0.0.1:8080", "db.local:5432", "Authorization: …"]);
  });

  // Task review, 2026-11-20: "apikey:123456" passed as a host and port.
  it("shows only a real host and port as it is", () => {
    expect(
      shownArgs(["apikey:123456", "ghp_A1b2C3d4E5f6G7h8I9j0:443", "localhost:99999", "localhost:3000"]),
    ).toEqual(["apikey: …", "…", "localhost: …", "localhost:3000"]);
  });
});
