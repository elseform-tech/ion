import { describe, expect, it } from "vitest";
import { OPENCODE } from "./harnesses.js";

// Regression (final review I8): a repo's opencode.json could set permissions back to "allow".
describe("opencode environment", () => {
  it("asks for edits, shell and web at every level, and ignores the repo's opencode config", () => {
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "x/y", permission: { edit: "allow" } });
    try {
      const env = OPENCODE.env?.() ?? {};
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
      const ask = { edit: "ask", bash: "ask", webfetch: "ask" };
      expect(config.model).toBe("x/y");
      expect(config.permission).toEqual(ask);
      expect(config.agent.build.permission).toEqual(ask);
      expect(config.agent.plan.permission).toEqual(ask);
      expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    } finally {
      delete process.env.OPENCODE_CONFIG_CONTENT;
    }
  });
});
