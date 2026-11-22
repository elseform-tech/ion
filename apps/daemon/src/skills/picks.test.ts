import type { SkillInfo } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { chatPicks, ionPicks, readsResources, resolvePicks } from "./picks.js";

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
  bodyOf: (s: SkillInfo) => (s.id === "~/x/pdf" ? "Fill with fill.py." : null),
  commands: [
    { name: "review", description: "Review the diff", body: "Review it.", runs: true },
    { name: "mine", description: "", body: "Do mine.", runs: false },
  ],
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
      ["mine", "command", "own"],
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
    const names = {
      skills: ["review", "mine", "pdf", "brainstorm", "nope"],
      mentions: ["everything", "slack"],
    };
    expect(resolvePicks("claude-code", at, names)).toEqual({
      skills: [
        { name: "review", kind: "command" },
        { name: "mine", kind: "command", body: "Do mine." },
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

  // Security review, 2026-11-21: a name two different skills share (a repo's named like yours) picks neither.
  it("refuses a name more than one different skill has", () => {
    const twin = skill("pdf", { id: "repo/pdf", whose: "shared", on: true, project: "app", hash: "other" });
    const names = { skills: ["pdf"] };
    expect(resolvePicks("grok-build", { ...at, skills: [...SKILLS, twin] }, names).skills).toEqual([]);
    const listed = chatPicks("grok-build", { ...at, commands: [], skills: [...SKILLS, twin] }).skills;
    expect(listed.map((x) => x.name)).toEqual([]);
    // The same skill in two agents' folders (the same contents) is one skill.
    const same = skill("pdf", { id: "~/y/pdf", whose: "shared", on: true });
    expect(resolvePicks("grok-build", { ...at, skills: [...SKILLS, same] }, names).skills).toHaveLength(1);
  });

  // Task review, 2026-11-21: "@" lists the resources of servers ion runs; a pick is "<server> resource <uri>".
  it("lists a served server's resources under it, and a picked one reaches the agent", () => {
    const res = { everything: [{ name: "Readme", uri: "file:///readme" }] };
    const p = chatPicks("claude-code", { ...at, resources: res });
    expect(p.servers.find((x) => x.kind === "resource")).toEqual({
      ...{ name: "Readme", description: "file:///readme", kind: "resource", from: "ion" },
      ...{ server: "everything", uri: "file:///readme" },
    });
    const m = { mentions: ["everything resource file:///readme", "everything resource file:///nope"] };
    expect(resolvePicks("claude-code", { ...at, resources: res }, m).mentions).toEqual([
      "everything resource file:///readme",
    ]);
  });

  // Live, Grok 2026-11-21: Grok has no way to read an MCP resource (it searched the web instead). "@" lists resources
  // only for an agent that reads them (Claude Code: @server:uri).
  it("lists resources only for an agent that reads them", () => {
    expect(readsResources("claude-code")).toBe(true);
    expect(readsResources("grok-build")).toBe(false);
    expect(readsResources("opencode")).toBe(false);
  });
});
