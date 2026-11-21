import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kindOfAction, UnsureLog } from "./unsure.js";

const DAY = 86_400_000;
const bash = (command: string) => ({ toolName: "Bash", kind: "command", input: { command } });

// The user, 2026-11-21: when Auto is often unsure about one kind of action, it's noted once so a rule can be added.
describe("unsure too often", () => {
  it("names an action by its command's first words, or an MCP tool by name", () => {
    expect(kindOfAction(bash("npm publish --tag next"))).toBe("npm publish");
    expect(kindOfAction(bash("./deploy.sh prod"))).toBe("./deploy.sh");
    expect(kindOfAction({ toolName: "mcp__db__query", kind: "mcp", input: {} })).toBe("mcp__db__query");
    expect(kindOfAction({ toolName: "WebFetch", kind: "fetch", input: { url: "x" } })).toBe("WebFetch");
  });

  it("unsure 5 times on one kind of action is noted once", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ion-unsure-")), "unsure.json");
    let now = 1_000 * DAY;
    const log = new UnsureLog(file, () => now);
    const said: string[] = [];
    for (let i = 0; i < 4; i++) expect(log.add(bash(`npm publish ${i}`))).toBeNull();
    expect(log.notes()).toEqual([]);
    const fifth = log.add(bash("npm publish x"));
    expect(fifth).toBe("Auto often isn't sure about: npm publish");
    said.push(fifth!);
    expect(log.add(bash("npm publish y"))).toBeNull();
    expect(log.notes()).toEqual(["Auto often isn't sure about: npm publish"]);
    // Kept across restarts.
    expect(new UnsureLog(file, () => now).notes()).toEqual(["Auto often isn't sure about: npm publish"]);
    // Older than 7 days doesn't count.
    now += 8 * DAY;
    const fresh = new UnsureLog(file, () => now);
    expect(fresh.notes()).toEqual(["Auto often isn't sure about: npm publish"]);
    for (let i = 0; i < 4; i++) expect(fresh.add(bash("make deploy"))).toBeNull();
    now += 8 * DAY;
    expect(fresh.add(bash("make deploy"))).toBeNull();
  });
});
