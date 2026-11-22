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
    // Live, Claude Code 2026-11-21: with ion's settingSources [] a plugin's command runs by name, a settings-folder
    // command doesn't ("isn't installed in this session"): ~/.claude/commands go as their text (runs: false).
    expect(ownCommands("claude-code", o)).toEqual([
      { name: "review", description: "Review the diff", body: "Review it.", runs: false },
      { name: "kit:ship", description: "", body: "Ship the release.", runs: true },
    ]);
    expect(ownCommands("opencode", o)).toEqual([
      { name: "tidy", description: "Tidy up", body: "Tidy.", runs: true },
      { name: "lint", description: "Lint it", body: "Run the linter", runs: true },
    ]);
    expect(ownCommands("codex", o)).toEqual([
      { name: "prompts:plan", description: "Make a plan", body: "Plan $ARGUMENTS.", runs: false },
    ]);
    expect(ownCommands("grok-build", o)).toEqual([]);
  });

  // Task 11, 2026-11-22 (tour): "/" in a Claude Code chat left out its plugins' skills (superpowers:brainstorming), though
  // the plugin reaches the chat. They're listed as `plugin:skill`, sent as their text (not run by name, unverified live).
  it("lists a Claude Code plugin's skills as plugin:skill", () => {
    const home = mkdtempSync(join(tmpdir(), "ion-cmds-"));
    const kit = join(home, "kit");
    put(join(kit, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kit" }));
    put(join(kit, "skills", "plan", "SKILL.md"), "---\nname: plan\ndescription: Plans it\n---\nPlan it.");
    put(join(kit, "skills", "loose.md"), "not a skill");
    put(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "kit@m": [{ scope: "user", installPath: kit }] } }),
    );
    put(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "kit@m": true } }));
    expect(ownCommands("claude-code", { home, env: {}, projects: [] })).toEqual([
      { name: "kit:plan", description: "Plans it", body: "Plan it.", runs: false },
    ]);
  });
});
