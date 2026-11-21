import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ownCommands } from "./commands.js";

const put = (p: string, t: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, t);
};

// The user, 2026-11-21, after Task 13: "/" lists the chosen agent's own skills and commands first.
describe("each agent's own commands", () => {
  it("reads Claude Code's, its plugins', opencode's and Codex's prompts, with one line each", () => {
    const home = mkdtempSync(join(tmpdir(), "ion-cmds-"));
    put(join(home, ".claude", "commands", "review.md"), "---\ndescription: Review the diff\n---\nReview it.");
    put(join(home, ".claude", "commands", "notes.txt"), "not a command");
    const kit = join(home, "kit");
    put(join(kit, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kit" }));
    put(join(kit, "commands", "ship.md"), "Ship the release.");
    put(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "kit@m": [{ scope: "user", installPath: kit }] } }),
    );
    put(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "kit@m": true } }));
    put(join(home, ".config", "opencode", "command", "tidy.md"), "---\ndescription: Tidy up\n---\nTidy.");
    put(
      join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({ command: { lint: { template: "Run the linter", description: "Lint it" } } }),
    );
    put(join(home, ".codex", "prompts", "plan.md"), "---\ndescription: Make a plan\n---\nPlan $ARGUMENTS.");
    const o = { home, env: {}, projects: [] };
    expect(ownCommands("claude-code", o)).toEqual([
      { name: "review", description: "Review the diff", body: "Review it." },
      { name: "kit:ship", description: "", body: "Ship the release." },
    ]);
    expect(ownCommands("opencode", o)).toEqual([
      { name: "tidy", description: "Tidy up", body: "Tidy." },
      { name: "lint", description: "Lint it", body: "Run the linter" },
    ]);
    expect(ownCommands("codex", o)).toEqual([
      { name: "prompts:plan", description: "Make a plan", body: "Plan $ARGUMENTS." },
    ]);
    expect(ownCommands("grok-build", o)).toEqual([]);
  });
});
