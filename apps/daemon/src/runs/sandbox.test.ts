import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { describe, expect, it, vi } from "vitest";
import { runEnv } from "./run-env.js";
import {
  agentConfigs,
  gitSandbox,
  ionDenied,
  launchSandbox,
  machineSandbox,
  notSandboxed,
  runSandbox,
  serverSandbox,
} from "./sandbox.js";

// The user, 2026-11-21: agents run in the OS sandbox, away from ion's own files: ion's data, config and cache folders
// are out of reach, except the run's own worktree, its skills plugin (read-only) and ion's launcher (read and run).
describe("a run's sandbox", () => {
  const o = {
    dataDir: "/h/.local/share/ion",
    configFile: "/h/.config/ion/config.toml",
    cacheDir: "/h/.cache",
  };

  it("keeps ion's folders away and lets through the run's worktree, skills and launcher", () => {
    const sb = runSandbox("seatbelt", {
      ...o,
      cwd: "/h/.local/share/ion/worktrees/c1",
      pluginDir: "/h/.local/share/ion/skills/r1",
      ionBin: "/h/.local/share/ion/bin",
      harness: "grok-build",
      env: { HOME: "/h" },
    });
    expect(sb).toEqual({
      kind: "seatbelt",
      paths: {
        deny: ["/h/.local/share/ion", "/h/.config/ion", "/h/.cache/ion"],
        read: ["/h/.local/share/ion/skills/r1", "/h/.local/share/ion/bin"],
        write: ["/h/.local/share/ion/worktrees/c1"],
        noWrite: ["/h/.codex", "/h/.claude", "/h/.claude.json", "/h/.config/opencode", "/h/.opencode"],
      },
    });
  });

  // Task review, 2026-11-21: a run could write another agent's config (a Grok run adding a hook to ~/.claude, a server
  // to ~/.codex/config.toml) for a later chat. Every run gets every other agent's config folder read-only; its own
  // agent's config files the adapter adds (its sessions and state it must still write).
  it("keeps every other agent's config read-only", () => {
    const env = { HOME: "/h", GROK_HOME: "/g" };
    const all = ["/h/.codex", "/h/.claude", "/h/.claude.json", "/h/.config/opencode", "/h/.opencode", "/g"];
    expect(agentConfigs("grok-build", env)).toEqual(all.filter((p) => p !== "/g"));
    expect(agentConfigs("claude-code", env)).toEqual(all.filter((p) => !p.startsWith("/h/.claude")));
    expect(agentConfigs("fake", env)).toEqual(all);
    const sb = runSandbox("seatbelt", { ...o, cwd: "/w", harness: "opencode", env });
    expect(sb?.paths.noWrite).toEqual(all.filter((p) => !p.includes("opencode")));
  });

  // Task review, 2026-11-21: Codex's own process, its own stdio servers and notify run outside any sandbox, and its
  // sandbox isn't verified against escalation live yet: it gets its sandbox, but ion's word rules stay on for it.
  it("counts only ion's own sandbox as sandboxed (the word rules stay on for Codex)", () => {
    const ctx = { ...o, sandbox: "seatbelt" as const };
    const at = { cwd: "/w", harness: "x" };
    expect(launchSandbox("ion", ctx, at).sandboxed).toBe(true);
    const codex = launchSandbox("own", ctx, at);
    expect(codex.sandbox?.kind).toBe("seatbelt");
    expect(codex.sandboxed).toBeUndefined();
  });

  // Task review, 2026-11-21: with ION_HOME holding your projects (the tour, tests), denying the whole folder hid the
  // projects from git and the agents. ion's own files there are denied; the projects aren't.
  it("denies ion's own files in a config folder that holds projects, and the whole folder otherwise", () => {
    const home = mkdtempSync(join(tmpdir(), "ion-denied-"));
    const configFile = join(home, "config.toml");
    const at = { dataDir: join(home, "data"), configFile, cacheDir: "/c" };
    expect(ionDenied(at)).toEqual([join(home, "data"), home, "/c/ion"]);
    saveUserConfig(configFile, {
      ...DEFAULT_CONFIG,
      folders: { ...DEFAULT_CONFIG.folders, projects: join(home, "projects") },
    });
    expect(ionDenied(at)).toEqual([
      join(home, "data"),
      configFile,
      join(home, "mcp.json"),
      join(home, "skills"),
      "/c/ion",
    ]);
  });

  // Re-review, 2026-11-21: ion's servers and git kept every agent's config writable (a planted git filter wrote
  // ~/.codex/notify.sh). Both keep them read-only, as runs do.
  it("keeps every agent's config read-only for ion's servers and git", () => {
    const env = { HOME: "/h", GROK_HOME: "/g" };
    const all = ["/h/.codex", "/h/.claude", "/h/.claude.json", "/h/.config/opencode", "/h/.opencode", "/g"];
    expect(serverSandbox(o, "seatbelt", env)?.paths.noWrite).toEqual(all);
    expect(gitSandbox(o, "seatbelt", env)?.paths.noWrite).toEqual(all);
  });

  // The user, 2026-11-21: "Neither available: the run still starts", Settings says "Not sandboxed", logged once.
  it("is none where the computer has no sandbox, said once in the daemon's log", () => {
    expect(runSandbox("none", { ...o, cwd: "/p" })).toBeUndefined();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(machineSandbox("none")).toBe("none");
    expect(machineSandbox("none")).toBe("none");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("not sandboxed");
    warn.mockRestore();
  });

  // The user, 2026-11-21: Settings → Agents shows "Not sandboxed" where an agent's chats run without a sandbox.
  it("says an agent isn't sandboxed on a computer without one, or when it starts no process ion can wrap", () => {
    expect(notSandboxed("ion", "seatbelt")).toBe(false);
    expect(notSandboxed("own", "bwrap")).toBe(false);
    expect(notSandboxed("ion", "none")).toBe(true);
    expect(notSandboxed("own", "none")).toBe(true);
    expect(notSandboxed(undefined, "seatbelt")).toBe(true);
  });

  // The user, 2026-11-21: daemon.json can't be read from a run, so ion's port reaches the CLI in its env.
  it("gives a run ion's port beside its key", () => {
    expect(runEnv({ chatId: "c1", cliKey: "k" }, undefined, 4321)).toEqual({
      ION_CHAT: "c1",
      ION_RUN_KEY: "k",
      ION_PORT: "4321",
    });
  });
});
