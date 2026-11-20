import { describe, expect, it } from "vitest";
import { dropInheritedMarkers } from "./env.js";

// Final review, 2026-11-19: a daemon started from a chat's tool call inherited that chat's ION_CHAT and passed it on
// to ion chief, the project ions and the judge (which start agents with the daemon's environment), so they showed in
// that chat's Tasks, stoppable. The daemon drops it at startup; only a chat's run sets it (runs/manager.ts, tested
// there: "marks each run's agent process with its chat").
describe("dropInheritedMarkers", () => {
  it("drops an inherited ION_CHAT and keeps the rest", () => {
    const env: NodeJS.ProcessEnv = { ION_CHAT: "chat_1", PATH: "/bin" };
    dropInheritedMarkers(env);
    expect(env).toEqual({ PATH: "/bin" });
  });

  // Security review, 2026-11-19: only ION_CHAT was dropped; a daemon started from a run's tool call kept that run's
  // gate address and key (and MCP keys), and ion turns and the judge, started with the daemon's environment, carried them.
  it("drops every per-run variable and keeps the rest", () => {
    const env: NodeJS.ProcessEnv = {
      ION_CHAT: "c",
      ION_GATE_URL: "http://127.0.0.1:1/gate/key",
      GROK_FOLDER_TRUST: "1",
      OPENCODE_CONFIG_CONTENT: "{}",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      ION_MCP_H0: "Bearer key",
      PATH: "/bin",
      HOME: "/home/a",
    };
    dropInheritedMarkers(env);
    dropInheritedMarkers(env);
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/a" });
  });
});
