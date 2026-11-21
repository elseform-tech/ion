import type { SkillInfo } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { chatPicks, ionPicks, resolvePicks } from "./picks.js";

const skill = (name: string, more: Partial<SkillInfo>): SkillInfo => ({
  ...{ id: `~/x/${name}`, name, description: `${name} things`, whose: "claude", where: "~", on: false },
  ...{ support: {}, hash: "h", readers: [] },
  ...more,
});
const SKILLS = [
  skill("brainstorm", { own: "claude-code", on: true, readers: ["claude-code", "opencode"] }),
  skill("pdf", { whose: "ion", on: true, support: { "claude-code": "ion" } }),
  skill("drafts", { whose: "ion", on: false, support: { "claude-code": "ion" } }),
  skill("deploy", { whose: "codex", on: false, readers: ["codex"], own: "codex" }),
];
const at = {
  skills: SKILLS,
  bodyOf: (n: string) => (n === "pdf" ? "Fill with fill.py." : null),
  commands: [{ name: "review", description: "Review the diff", body: "Review it." }],
  servers: [
    { name: "everything", on: true },
    { name: "slack", on: false },
  ],
  own: [{ name: "playwright" }],
};

// The user, 2026-11-21: "/" lists the chosen agent's own skills and commands plus ion's; "@" its servers.
describe("/ lists the chat's skills and filters", () => {
  it("lists the agent's own first, then ion's that are on; servers it can use", () => {
    const p = chatPicks("claude-code", at);
    expect(p.skills.map((s) => [s.name, s.kind, s.from])).toEqual([
      ["review", "command", "own"],
      ["brainstorm", "skill", "own"],
      ["pdf", "skill", "ion"],
    ]);
    expect(p.servers.map((s) => [s.name, s.from])).toEqual([
      ["playwright", "own"],
      ["everything", "ion"],
    ]);
    // Codex's own skill reaches Codex only; ion's that are on reach every agent (as their text).
    expect(chatPicks("codex", { ...at, commands: [] }).skills.map((s) => s.name)).toEqual(["deploy", "pdf"]);
  });

  it("an ion's chat lists every skill that's on, and the servers that are on", () => {
    const p = ionPicks({ skills: SKILLS, servers: at.servers });
    expect(p.skills.map((s) => s.name)).toEqual(["brainstorm", "pdf"]);
    expect(p.servers.map((s) => s.name)).toEqual(["everything"]);
  });

  it("a picked skill reaches the run (Claude Code by name; others as context)", () => {
    const names = { skills: ["review", "pdf", "brainstorm", "nope"], mentions: ["everything", "slack"] };
    expect(resolvePicks("claude-code", at, names)).toEqual({
      skills: [
        { name: "review", kind: "command" },
        { name: "pdf", kind: "skill" },
        { name: "brainstorm", kind: "skill" },
      ],
      mentions: ["everything"],
    });
    // Grok can't load ion's skill: it gets its text.
    expect(resolvePicks("grok-build", { ...at, commands: [] }, names).skills).toEqual([
      { name: "pdf", kind: "skill", body: "Fill with fill.py." },
    ]);
  });
});
