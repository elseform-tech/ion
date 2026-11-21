import { createHmac } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { createSkills, type SkillReaders } from "./index.js";
import { runSkillsOf } from "./run.js";

// The user, 2026-11-20: Skills are "the skills your agents already have", on or off, passed to Claude Code the way
// T3 Code does (the Agent SDK's plugins), with ion's settings still off. A skill is instructions every Claude chat
// follows, so it's off until you turn it on, and turning it on is consent to exactly what it says.

const sign = async (t: string) => createHmac("sha256", "k").update(t).digest("hex").slice(0, 32);
const readers: SkillReaders = {
  "claude-code": { fromIon: true, own: [] },
  codex: { fromIon: false, own: ["codex", "shared"] },
  opencode: { fromIon: false, own: ["opencode", "claude", "shared"] },
};

function skill(dir: string, md: string, extra: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), md);
  for (const [f, t] of Object.entries(extra)) writeFileSync(join(dir, f), t);
}

const md = (name: string, description: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ion-skills-"));
  const home = join(root, "home");
  const project = join(home, "code", "app");
  const dataDir = join(root, "data");
  mkdirSync(project, { recursive: true });
  const skills = createSkills({ home, dataDir, sign, readers });
  return { root, home, project, dataDir, skills };
}

describe("skills", () => {
  it("finds skills in each agent's folders, with name and description", async () => {
    const { home, project, skills } = setup();
    skill(join(home, ".claude/skills/pdf"), md("pdf", "Reads PDFs\u0007 well"));
    skill(join(home, ".codex/skills/deploy"), md("deploy", '"Ships it"'));
    skill(join(home, ".config/opencode/skills/review"), md("review", "Reviews code"));
    skill(
      join(home, ".agents/skills/notes"),
      `---\nname: notes\ndescription: >\n  Keeps\n  notes\n---\nBody\n`,
    );
    skill(join(project, ".claude/skills/style"), md("style", "x".repeat(2000)));
    skill(join(project, ".opencode/skills/lint"), md("lint", "Lints"));
    skill(join(home, ".claude/skills/bare"), "No front matter here.\n");
    mkdirSync(join(home, ".claude/skills/empty"), { recursive: true });
    const list = await skills.list([], [project]);
    const by = (n: string) => list.find((s) => s.name === n);
    expect(list.map((s) => [s.name, s.whose, s.where]).sort()).toEqual(
      [
        ["bare", "claude", "~/.claude/skills/bare"],
        ["deploy", "codex", "~/.codex/skills/deploy"],
        ["lint", "opencode", "~/code/app/.opencode/skills/lint"],
        ["notes", "shared", "~/.agents/skills/notes"],
        ["pdf", "claude", "~/.claude/skills/pdf"],
        ["review", "opencode", "~/.config/opencode/skills/review"],
        ["style", "claude", "~/code/app/.claude/skills/style"],
      ].sort(),
    );
    expect(by("pdf")?.description).toBe("Reads PDFs well");
    expect(by("deploy")?.description).toBe("Ships it");
    expect(by("notes")?.description).toBe("Keeps notes");
    expect(by("style")?.description.length).toBeLessThanOrEqual(300);
    expect(by("bare")?.description).toBe("");
  });

  it("other agents show their skills as their own", async () => {
    const { home, skills } = setup();
    skill(join(home, ".claude/skills/pdf"), md("pdf", "PDFs"));
    skill(join(home, ".codex/skills/deploy"), md("deploy", "Ships"));
    const list = await skills.list([], []);
    expect(list.find((s) => s.name === "pdf")?.support).toEqual({ "claude-code": "ion", opencode: "own" });
    expect(list.find((s) => s.name === "deploy")?.support).toEqual({ codex: "own" });
    await expect(
      skills.turn([], list.find((s) => s.name === "deploy")!.id, true, { projects: [] }),
    ).rejects.toThrow("Codex uses its own");
  });

  it("a skill is off until turned on", async () => {
    const { home, skills } = setup();
    skill(join(home, ".claude/skills/pdf"), md("pdf", "PDFs"));
    const [s] = await skills.list([], []);
    expect(s).toMatchObject({ on: false, new: true });
    const on = await skills.turn([], s!.id, true, { projects: [] });
    expect(on).toEqual([expect.stringMatching(/^~\/\.claude\/skills\/pdf@[0-9a-f]{32}$/)]);
    expect((await skills.list(on, []))[0]).toMatchObject({ on: true });
    expect((await skills.list(on, []))[0]).not.toHaveProperty("new");
    expect(await skills.turn(on, s!.id, false, { projects: [] })).toEqual([]);
    // A record written by hand (not signed with ion's key) turns nothing on.
    expect((await skills.list([`${s!.id}@${"0".repeat(32)}`], []))[0]).toMatchObject({
      on: false,
      changed: true,
    });
  });

  it("a changed skill turns off", async () => {
    const { home, skills } = setup();
    const dir = join(home, ".claude/skills/pdf");
    skill(dir, md("pdf", "PDFs"), { "helper.py": "print(1)\n" });
    const on = await skills.turn([], (await skills.list([], []))[0]!.id, true, { projects: [] });
    writeFileSync(join(dir, "helper.py"), "print(2)\n");
    expect((await skills.list(on, []))[0]).toMatchObject({ on: false, changed: true });
    expect(await skills.forRun({ runId: "r1", on, projectDir: null })).toBeNull();
    writeFileSync(join(dir, "helper.py"), "print(1)\n");
    writeFileSync(join(dir, "SKILL.md"), md("pdf", "PDFs", "Do something else."));
    expect((await skills.list(on, []))[0]).toMatchObject({ on: false, changed: true });
  });

  // Final review, 2026-11-21: once a run's copy kept a script's exec bit, `chmod +x` on a file of a skill you'd turned
  // on made it runnable without asking you again. The exec bit is part of what you consent to.
  it("a skill file made executable turns the skill off until you turn it on again", async () => {
    const { home, project, skills } = setup();
    const dir = join(home, ".claude/skills/pdf");
    skill(dir, md("pdf", "PDFs"), { "helper.sh": "echo hi\n" });
    chmodSync(join(dir, "helper.sh"), 0o644);
    const id = (await skills.list([], []))[0]!.id;
    const on = await skills.turn([], id, true, { projects: [] });
    chmodSync(join(dir, "helper.sh"), 0o755);
    expect((await skills.list(on, []))[0]).toMatchObject({ on: false, changed: true });
    expect(await skills.forRun({ runId: "r1", on, projectDir: project })).toBeNull();
    const again = await skills.turn(on, id, true, { projects: [] });
    expect((await skills.list(again, []))[0]).toMatchObject({ on: true });
    chmodSync(join(dir, "helper.sh"), 0o644);
    expect((await skills.list(on, []))[0]).toMatchObject({ on: true });
  });

  it("a Claude Code run gets only the enabled skills as a plugin", async () => {
    const { home, project, skills } = setup();
    skill(
      join(home, ".claude/skills/pdf"),
      `---\nname: pdf\ndescription: PDFs\nallowed-tools: Bash(*)\nhooks:\n  PreToolUse: []\n---\nRead it.\n`,
      { "ref.md": "more\n" },
    );
    skill(join(home, ".claude/skills/off"), md("off", "Not on"));
    skill(join(project, ".claude/skills/style"), md("style", "Style"));
    const list = await skills.list([], [project]);
    let on: string[] = [];
    for (const n of ["pdf", "style"])
      on = await skills.turn(on, list.find((s) => s.name === n)!.id, true, { projects: [project] });
    const dir = await skills.forRun({ runId: "r1", on, projectDir: project });
    expect(dir).not.toBeNull();
    expect(JSON.parse(readFileSync(join(dir!, ".claude-plugin/plugin.json"), "utf8"))).toMatchObject({
      name: "ion-skills",
    });
    expect(readdirSync(join(dir!, "skills")).sort()).toEqual(["pdf", "style"]);
    const copied = readFileSync(join(dir!, "skills/pdf/SKILL.md"), "utf8");
    // Only its name and description: no allowed-tools (they'd skip asking), no hooks of its own.
    expect(copied).toBe(`---\nname: pdf\ndescription: "PDFs"\n---\nRead it.\n`);
    expect(readFileSync(join(dir!, "skills/pdf/ref.md"), "utf8")).toBe("more\n");
    // Another project's run doesn't get this project's skills.
    const other = await skills.forRun({ runId: "r2", on, projectDir: join(home, "elsewhere") });
    expect(readdirSync(join(other!, "skills"))).toEqual(["pdf"]);
  });

  // Final review, 2026-11-21: every copied file was 0600, so a skill's script (`./run.sh`) wouldn't run.
  it("a skill's script keeps its exec bit (0700); other files are 0600", async () => {
    const { home, project, skills } = setup();
    skill(join(home, ".claude/skills/pdf"), md("pdf", "PDFs"), {
      "run.sh": "#!/bin/sh\necho hi\n",
      "ref.md": "x",
    });
    chmodSync(join(home, ".claude/skills/pdf/run.sh"), 0o755);
    chmodSync(join(home, ".claude/skills/pdf/ref.md"), 0o644);
    const on = await skills.turn([], (await skills.list([], []))[0]!.id, true, { projects: [] });
    const dir = await skills.forRun({ runId: "r1", on, projectDir: project });
    expect(statSync(join(dir!, "skills/pdf/run.sh")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir!, "skills/pdf/ref.md")).mode & 0o777).toBe(0o600);
  });

  it("the plugin folder is in ion's data folder, rebuilt per run, removed at run end", async () => {
    const { home, project, dataDir, skills } = setup();
    skill(join(home, ".claude/skills/pdf"), md("pdf", "PDFs"));
    const on = await skills.turn([], (await skills.list([], []))[0]!.id, true, { projects: [] });
    const dir = await skills.forRun({ runId: "r1", on, projectDir: project });
    expect(dir).toBe(join(dataDir, "skills", "r1"));
    expect(dir!.startsWith(project)).toBe(false);
    writeFileSync(join(dir!, "skills", "stale.txt"), "left over");
    await skills.forRun({ runId: "r1", on, projectDir: project });
    expect(existsSync(join(dir!, "skills", "stale.txt"))).toBe(false);
    await skills.remove("r1");
    expect(existsSync(dir!)).toBe(false);
    // Nothing turned on: no plugin at all.
    expect(await skills.forRun({ runId: "r3", on: [], projectDir: project })).toBeNull();
    // A run id that isn't a plain name can't point the folder elsewhere.
    await expect(skills.forRun({ runId: "../x", on, projectDir: project })).rejects.toThrow();
  });

  it("a symlinked skill outside home isn't read", async () => {
    const { root, home, skills } = setup();
    const outside = join(root, "outside", "evil");
    skill(outside, md("evil", "From outside home"));
    const inside = join(home, "dotfiles", "good");
    skill(inside, md("good", "From inside home"));
    mkdirSync(join(home, ".claude/skills"), { recursive: true });
    symlinkSync(outside, join(home, ".claude/skills/evil"));
    symlinkSync(inside, join(home, ".claude/skills/good"));
    // A SKILL.md that's itself a link to a file outside isn't read either.
    mkdirSync(join(home, ".claude/skills/link"));
    symlinkSync(join(outside, "SKILL.md"), join(home, ".claude/skills/link/SKILL.md"));
    expect((await skills.list([], [])).map((s) => s.name)).toEqual(["good"]);
  });

  it("only Claude Code runs get a plugin; other agents use their own", async () => {
    const { root, home, project, skills } = setup();
    skill(join(home, ".claude/skills/pdf"), md("pdf", "PDFs"));
    const on = await skills.turn([], (await skills.list([], []))[0]!.id, true, { projects: [] });
    const configFile = join(root, "config.toml");
    const c = DEFAULT_CONFIG;
    const projects = [{ id: "app", path: project, starred: false }];
    saveUserConfig(configFile, { ...c, projects, tools: { ...c.tools, skills: { on } } });
    const run = runSkillsOf(skills, configFile);
    const projectId = "app";
    expect(await run.forRun({ runId: "r1", harness: "opencode", projectId })).toBeNull();
    expect(await run.forRun({ runId: "r2", harness: "codex", projectId })).toBeNull();
    expect(await run.forRun({ runId: "r3", harness: "claude-code", projectId })).toMatch(/skills\/r3$/);
  });

  // Task review, 2026-11-21: a SKILL.md deeper in a skill was copied too, so Claude Code saw a second skill nobody
  // turned on (any case: skill.md on a case-insensitive disk is SKILL.md).
  it("leaves out a SKILL.md below a skill's top level", async () => {
    const { home, skills } = setup();
    const dir = join(home, ".claude/skills/pdf");
    skill(dir, md("pdf", "PDFs"), { "ref.md": "more\n" });
    mkdirSync(join(dir, "inner"));
    writeFileSync(join(dir, "inner", "SKILL.md"), md("sneaky", "Not turned on"));
    writeFileSync(join(dir, "inner", "Skill.MD"), md("sneaky2", "Not turned on"));
    const on = await skills.turn([], (await skills.list([], []))[0]!.id, true, { projects: [] });
    const out = await skills.forRun({ runId: "r1", on, projectDir: null });
    expect(readdirSync(join(out!, "skills/pdf")).sort()).toEqual(["SKILL.md", "ref.md"]);
  });

  // Task review, 2026-11-21: a skills folder ion can't read (EACCES) threw, and Tools couldn't list anything.
  it.skipIf(process.getuid?.() === 0)("skips a skills folder it can't read", async () => {
    const { home, skills } = setup();
    skill(join(home, ".claude/skills/pdf"), md("pdf", "PDFs"));
    skill(join(home, ".codex/skills/deploy"), md("deploy", "Ships"));
    chmodSync(join(home, ".codex/skills"), 0o000);
    try {
      expect((await skills.list([], [])).map((s) => s.name)).toEqual(["pdf"]);
    } finally {
      chmodSync(join(home, ".codex/skills"), 0o700);
    }
  });

  // Task review, 2026-11-21: the walk counted only files it kept, so a folder of countless dotfiles or folders kept
  // ion reading; every entry counts now, and a skills folder stops at the cap.
  it("stops reading a skills folder at the entry cap", async () => {
    const { home, skills } = setup();
    const dir = join(home, ".claude/skills/huge");
    skill(dir, md("huge", "Too many entries"));
    for (let i = 0; i < 5001; i++) writeFileSync(join(dir, `.f${i}`), "");
    skill(join(home, ".codex/skills/deploy"), md("deploy", "Ships"));
    expect((await skills.list([], [])).map((s) => s.name)).toEqual(["deploy"]);
  });

  // Task review, 2026-11-21: with the keychain locked a run's skills were left out without a word.
  it("says once in the log when a run's skills are skipped for a locked keychain", async () => {
    const { home, dataDir } = setup();
    skill(join(home, ".claude/skills/pdf"), md("pdf", "PDFs"));
    const ok = createSkills({ home, dataDir, sign, readers });
    const on = await ok.turn([], (await ok.list([], []))[0]!.id, true, { projects: [] });
    const locked = createSkills({ home, dataDir, readers, sign: () => Promise.reject(new Error("locked")) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await locked.forRun({ runId: "r1", on, projectDir: null })).toBeNull();
    expect(warn.mock.calls).toEqual([["skills skipped: ion can't read your keychain"]]);
    warn.mockRestore();
  });
});

// Security review, 2026-11-21: Claude Code's own skills in your home come on as they are, but a project's
// .claude/skills is written by the repo, not you: it isn't given until you turn it on, and it's marked as the repo's.
describe("a project's skills", () => {
  it("a project skill isn't given until consented", async () => {
    const { home, project, skills } = setup();
    skill(join(home, ".claude/skills/pdf"), md("pdf", "Reads PDFs"));
    skill(join(project, ".claude/skills/style"), md("style", "House style"));
    const own = { "claude-code": true };
    const list = await skills.list([], [project], own);
    expect(list.find((s) => s.name === "pdf")).toMatchObject({ on: true, own: "claude-code" });
    const style = list.find((s) => s.name === "style");
    expect(style).toMatchObject({ on: false, new: true, project: "app" });
    expect(style?.own).toBeUndefined();
    const dir = await skills.forRun({ runId: "r1", on: [], projectDir: project, own: true });
    expect(readdirSync(join(dir!, "skills"))).toEqual(["pdf"]);
    const on = await skills.turn([], style!.id, true, { projects: [project], own });
    const after = await skills.forRun({ runId: "r2", on, projectDir: project, own: true });
    expect(readdirSync(join(after!, "skills")).sort()).toEqual(["pdf", "style"]);
  });
});
