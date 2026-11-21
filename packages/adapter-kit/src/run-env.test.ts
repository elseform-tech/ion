import { describe, expect, it, vi } from "vitest";
import { agentEnv, setStandingDrop } from "./run-env.js";

// Task review, 2026-11-20: a key filled from ion's environment (`${NAME}` in mcp.json) still reached every agent,
// whose process inherits ion's environment. The names mcp.json uses, and any variable holding one of the run's
// keys, are left out.
describe("agentEnv", () => {
  it("leaves out the names mcp.json uses and any variable holding one of the run's keys", () => {
    const base = { PATH: "/bin", LINEAR_KEY: "k-linear-123", COPY: "tok-secret-99", HOME: "/h" };
    expect(agentEnv(base, { names: ["LINEAR_KEY", "UNSET_ONE"], values: ["tok-secret-99"] })).toEqual({
      PATH: "/bin",
      HOME: "/h",
    });
  });

  it("is the environment as it is with nothing to leave out", () => {
    expect(agentEnv({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });

  // Task review, 2026-11-20: version checks, model lists and logins started agents with ion's whole environment.
  it("leaves out the daemon's standing drop for every agent process, whoever starts it", () => {
    setStandingDrop(() => ({ names: ["GH_KEY"], values: ["copy-of-a-key"] }));
    try {
      expect(agentEnv({ PATH: "/bin", GH_KEY: "k", OTHER: "copy-of-a-key" })).toEqual({ PATH: "/bin" });
    } finally {
      setStandingDrop(undefined);
    }
  });

  // Task review, 2026-11-21: `${HOME}` in mcp.json stripped HOME (and a key equal to PATH's value, PATH) from every
  // agent: version checks failed and Claude lost its login. Standard variables are never left out.
  it("never leaves out PATH, HOME or other standard variables, by name or by value", () => {
    const base = {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/me",
      PWD: "/Users/me/x",
      LC_ALL: "C",
      GH_TOKEN: "tok-12345678",
    };
    const drop = {
      names: ["HOME", "PWD", "LC_ALL", "GH_TOKEN"],
      values: ["/Users/me", "/Users/me/x", "tok-12345678"],
    };
    expect(agentEnv(base, drop)).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/me",
      PWD: "/Users/me/x",
      LC_ALL: "C",
    });
  });

  // Task review, 2026-11-21 (automated security review): with no standing drop registered, agentEnv returned the
  // environment untouched; it now leaves out ion's own run variables at least, and says so once.
  it("fails closed with no standing drop: ion's run variables are left out, said once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setStandingDrop(undefined);
    try {
      const base = {
        PATH: "/bin",
        ION_GATE_URL: "https://x/gate/k",
        ION_MCP_H1: "Bearer k",
        OPENCODE_CONFIG_CONTENT: "{}",
      };
      expect(agentEnv(base)).toEqual({ PATH: "/bin" });
      agentEnv(base);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("an environment passed in is filtered too", () => {
    setStandingDrop(() => ({ names: ["GH_KEY"], values: [] }));
    try {
      expect(agentEnv({ GH_KEY: "k", PATH: "/bin" })).toEqual({ PATH: "/bin" });
    } finally {
      setStandingDrop(undefined);
    }
  });
});
