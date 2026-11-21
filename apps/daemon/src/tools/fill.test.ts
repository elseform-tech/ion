import { describe, expect, it } from "vitest";
import { keyAccount, memorySecrets, NO_KEYCHAIN, systemSecrets } from "../secrets/index.js";
import { fillServer, keysNeeded, lookupIn, refsOf } from "./fill.js";
import type { McpServer } from "./mcp-file.js";

const github: McpServer = {
  name: "github",
  transport: "stdio",
  command: "npx",
  args: ["--org", "${ORG}"],
  env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", PLAIN: "x" },
};
const linear: McpServer = {
  name: "linear",
  transport: "http",
  url: "https://mcp.example/${TEAM}/mcp",
  headers: { Authorization: "Bearer ${LINEAR_KEY}" },
};

// Plan 18 (the user, 2026-11-20: "we have to consider mcp that might require oauth, api-key or some kind of login"):
// a `${NAME}` in mcp.json is a key you entered in the app (kept in the keychain), else ion's environment.
describe("${NAME} in mcp.json", () => {
  it("${NAME} is filled from a key you entered, else the environment", async () => {
    const secrets = memorySecrets();
    await secrets.set(keyAccount("github", "GITHUB_TOKEN"), "from-keychain");
    const lookup = lookupIn(secrets, { GITHUB_TOKEN: "from-env", ORG: "acme" });
    expect(refsOf(github)).toEqual(["ORG", "GITHUB_TOKEN"]);
    expect(await fillServer(github, lookup)).toEqual({
      server: { ...github, args: ["--org", "acme"], env: { GITHUB_TOKEN: "from-keychain", PLAIN: "x" } },
    });
  });

  it("names what's missing, and only the names", async () => {
    const lookup = lookupIn(memorySecrets(), { TEAM: "t1" });
    expect(refsOf(linear)).toEqual(["TEAM", "LINEAR_KEY"]);
    expect(await fillServer(linear, lookup)).toEqual({ missing: ["LINEAR_KEY"] });
    const secrets = memorySecrets();
    await secrets.set(keyAccount("linear", "LINEAR_KEY"), "k");
    expect(await fillServer(linear, lookupIn(secrets, { TEAM: "t1" }))).toEqual({
      server: { ...linear, url: "https://mcp.example/t1/mcp", headers: { Authorization: "Bearer k" } },
    });
  });

  // Task review, 2026-11-20: Claude Code's .mcp.json takes ${NAME:-default}; so does ion's mcp.json.
  it("takes a default after :-", async () => {
    const s: McpServer = {
      name: "a",
      transport: "stdio",
      command: "x",
      args: ["${PORT:-8080}", "${HOST:-}"],
      env: {},
    };
    expect(refsOf(s)).toEqual(["PORT", "HOST"]);
    expect(await fillServer(s, lookupIn(memorySecrets(), {}))).toEqual({
      server: { ...s, args: ["8080", ""] },
    });
    expect(await fillServer(s, lookupIn(memorySecrets(), { PORT: "9" }))).toEqual({
      server: { ...s, args: ["9", ""] },
    });
  });

  // Security review, 2026-11-20: ${ION_TOKEN} would have handed a server ion's own daemon token, gate or MCP key.
  it("never fills a name starting with ION_", async () => {
    const secrets = memorySecrets();
    await secrets.set(keyAccount("a", "ION_X"), "k");
    const s: McpServer = {
      name: "a",
      transport: "stdio",
      command: "x",
      args: [],
      env: { T: "${ION_TOKEN}", U: "${ION_X}", V: "${ion_token}" },
    };
    expect(
      await fillServer(s, lookupIn(secrets, { ION_TOKEN: "daemon-secret", ion_token: "daemon-secret" })),
    ).toEqual({
      // Task review, 2026-11-20: in any case.
      missing: ["ION_TOKEN", "ION_X", "ion_token"],
    });
  });

  // Final review, 2026-11-21: local servers no longer start in the chat's worktree; one that needs it names
  // ${ION_WORKTREE}, which ion fills per run (in its bridge), so it's never a missing key.
  it("leaves ${ION_WORKTREE} for the run to fill, never a missing key", async () => {
    const s: McpServer = {
      name: "a",
      transport: "stdio",
      command: "x",
      args: ["--root", "${ION_WORKTREE}"],
      env: { W: "${ION_WORKTREE}" },
    };
    const lookup = lookupIn(memorySecrets(), {});
    expect(await keysNeeded(s, lookup)).toEqual({ missing: [], unread: [] });
    expect(await fillServer(s, lookup)).toEqual({ server: s });
  });

  // Task review, 2026-11-20: a keychain that can't be read isn't a missing key; the environment still counts.
  it("says when the keychain can't be read, unless the environment has it", async () => {
    const none = systemSecrets({ platform: "win32" });
    expect(await lookupIn(none, { A: "env" })("A", "s")).toBe("env");
    await expect(lookupIn(none, {})("A", "s")).rejects.toThrow(NO_KEYCHAIN);
  });
});
