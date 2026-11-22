import { describe, expect, it } from "vitest";
import { cleanWhy, onReadyAgents } from "./fallback.js";

// Security review, 2026-11-22: an agent's error went into the ion's reply and ion's log as it was. A key, a token or
// a link with a query string in it would have been shown. Only a short, clean line is.
describe("an agent's reason", () => {
  it("keeps plain words", () => {
    const why = "opencode's free usage is used up — try again later or pick another model";
    expect(cleanWhy(why)).toBe(why);
  });

  it("hides links, keys and tokens", () => {
    const key = ["sk", "ant", "api03", "Zx9Qw8Er7Ty6Ui5Op4As3Df2"].join("-");
    const why = `Failed at https://api.example.com/v1?token=abc123 with Bearer ${key} (api_key=hunter2Secret) ${"aB3".repeat(10)}`;
    const out = cleanWhy(why);
    for (const secret of ["api.example.com", "abc123", key, "hunter2Secret", "aB3aB3aB3"])
      expect(out).not.toContain(secret);
    expect(out).toContain("Failed at");
  });

  it("is one line of at most 200 characters", () => {
    const out = cleanWhy(`first line\nsecond ${"word ".repeat(100)}`);
    expect(out).not.toContain("\n");
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

// The user, 2026-11-22: an ion whose agent is limited goes on the next ready one, and its reply says why in one line:
// "On Grok Build — Claude Code is limited until 16:00". One that hits its limit mid-turn says so the same way.
describe("an ion's agent at its limit", () => {
  const until = new Date(2026, 10, 21, 16, 0).toISOString();
  const now = () => new Date(2026, 10, 21, 12, 0);
  const brain = (harness: string) => ({ harness, model: null, effort: null });
  it("skipped at the start: the reply names it and its reset", async () => {
    const r = await onReadyAgents(
      { ...brain("grok-build"), skipped: ["claude-code"] },
      {
        once: async () => ({ reply: "Done." }),
        next: async () => null,
        stay: () => false,
        limitedUntil: (h) => (h === "claude-code" ? until : null),
        now,
      },
    );
    expect(r.reply).toBe("Done.\n\n*On Grok Build — Claude Code is limited until 16:00.*");
  });

  it("limited mid-turn: the next agent's reply says so", async () => {
    let limited = false;
    const r = await onReadyAgents(brain("claude-code"), {
      once: async (b) => {
        if (b.harness === "grok-build") return { reply: "Done." };
        limited = true;
        return { reply: "", failed: { why: "Claude usage limit reached", did: false } };
      },
      next: async () => brain("grok-build"),
      stay: () => false,
      limitedUntil: (h) => (limited && h === "claude-code" ? until : null),
      now,
    });
    expect(r.reply).toBe("Done.\n\n*On Grok Build — Claude Code is limited until 16:00.*");
  });
});
