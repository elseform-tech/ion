import { describe, expect, it, vi } from "vitest";
import { runEnv } from "./run-env.js";
import { machineSandbox, notSandboxed, runSandbox } from "./sandbox.js";

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
    });
    expect(sb).toEqual({
      kind: "seatbelt",
      paths: {
        deny: ["/h/.local/share/ion", "/h/.config/ion", "/h/.cache/ion"],
        read: ["/h/.local/share/ion/skills/r1", "/h/.local/share/ion/bin"],
        write: ["/h/.local/share/ion/worktrees/c1"],
        noWrite: [],
      },
    });
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
