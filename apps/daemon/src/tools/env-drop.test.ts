import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv } from "@ion/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { keyAccount, memorySecrets } from "../secrets/index.js";
import { envDropOf, setDropLookup } from "./env-drop.js";
import { lookupIn } from "./fill.js";

// Task review, 2026-11-21 (automated security review of 6d3fce1): names were found by a regex over mcp.json's raw
// text, so a JSON-escaped `${NAME}` slipped past; values were only ion's environment, so a key from the keychain,
// or a header built from it, copied into another variable was inherited.
function configWith(servers: Record<string, unknown>, raw?: string): string {
  const home = mkdtempSync(join(tmpdir(), "ion-env-drop-"));
  writeFileSync(join(home, "mcp.json"), raw ?? JSON.stringify({ mcpServers: servers }));
  return join(home, "config.toml");
}

afterEach(() => setDropLookup(undefined));

describe("envDropOf", () => {
  it("an escaped reference is still left out", async () => {
    const raw =
      '{"mcpServers":{"gh":{"type":"http","url":"https://gh.example/mcp","headers":{"X":"\\u0024{GH_ESC_TOKEN}"}}}}';
    const drop = await envDropOf(configWith({}, raw));
    expect(drop.names).toContain("GH_ESC_TOKEN");
  });

  it("a key from the keychain, or the header made from it, copied into another variable is left out", async () => {
    const secrets = memorySecrets();
    await secrets.set(keyAccount("linear", "LINEAR_KEY"), "lin-secret-123");
    setDropLookup(lookupIn(secrets, {}));
    const file = configWith({
      linear: {
        type: "http",
        url: "https://l.example/mcp",
        headers: { Authorization: "Bearer ${LINEAR_KEY}" },
      },
      docs: { command: "docs-mcp", args: ["${HOME}/docs"] },
    });
    const env = agentEnv(
      { PATH: "/bin", HOME: "/Users/me", COPY: "lin-secret-123", HDR: "Bearer lin-secret-123", OK: "fine" },
      await envDropOf(file),
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/Users/me", OK: "fine" });
  });
});
