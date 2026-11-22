import { describe, expect, it } from "vitest";
import { dreamThink } from "./dreams.js";

// Security scan, 2026-11-22: a dream's status was read from its reply's words, so a model replying like ion's own
// failure line ("I couldn't reach my agent: …", "Codex is limited until 16:00") was taken as ion's. Only ion's own
// mark on the turn says it found no agent, or ran too long.
describe("a dream's status", () => {
  const dream = { pass: { see: "chats" as const, project: null }, max: 5, ms: 1000 };
  const think = (r: object) => dreamThink({ turn: async () => ({ threads: [], ...r }) as never });
  it("comes from ion's mark, never from the reply's words", async () => {
    expect((await think({ reply: "Codex is limited until 16:00" })("p", dream)).status).toBe("done");
    expect((await think({ reply: "I couldn't reach my agent: x" })("p", dream)).status).toBe("done");
    expect((await think({ reply: "x", ionLine: "no-agent" })("p", dream)).status).toBe("failed");
    expect((await think({ reply: "x", ionLine: "late" })("p", dream)).status).toBe("late");
  });
});
