import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keyAccount, memorySecrets } from "../secrets/index.js";
import { createTools } from "./index.js";

const KEY = keyAccount("docs", "DOCS_KEY");

/** A tools instance over a fresh mcp.json, a key kept for docs, and a way to save the file and read it again. */
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "ion-tools-"));
  const secrets = memorySecrets();
  const tools = createTools({ configFile: join(home, "config.toml"), secrets });
  const save = async (servers: Record<string, unknown>) => {
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    tools.read();
    await new Promise((r) => setTimeout(r, 10)); // the removal runs in the background
  };
  await save({ docs: { command: "docs-mcp", env: { T: "${DOCS_KEY}" } } });
  await secrets.set(KEY, "k-docs-123");
  return { secrets, save };
}

// Task review, 2026-11-21: a server's keys were deleted when its command or args changed, or when a typo left it
// out, so a small edit to mcp.json lost the key you'd entered. Keys go only when the server leaves the file.
describe("a server's keys", () => {
  it("stay when its args change", async () => {
    const { secrets, save } = await setup();
    await save({ docs: { command: "docs-mcp", args: ["--v2"], env: { T: "${DOCS_KEY}" } } });
    expect(await secrets.get(KEY)).toBe("k-docs-123");
  });

  it("stay through a typo in its entry", async () => {
    const { secrets, save } = await setup();
    await save({ docs: { comand: "docs-mcp", env: { T: "${DOCS_KEY}" } } });
    await save({ docs: { command: "docs-mcp", env: { T: "${DOCS_KEY}" } } });
    expect(await secrets.get(KEY)).toBe("k-docs-123");
  });

  it("go when it's removed from the file", async () => {
    const { secrets, save } = await setup();
    await save({});
    expect(await secrets.get(KEY)).toBeNull();
  });
});
