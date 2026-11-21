import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillInfo, SkillWhose } from "@ion/schema";
import { UserError } from "../api/errors.js";
import { type Sign, sameMark } from "../secrets/consent-key.js";
import { CANT_READ_KEYCHAIN } from "../secrets/index.js";
import { type FoundSkill, findSkills } from "./find.js";
import { pluginDirOf, writePlugin } from "./plugin.js";

/** By agent id: whether it takes skills from ion (Claude Code), and whose folders it reads itself. */
export type SkillReaders = Record<string, { fromIon: boolean; own: SkillWhose[] }>;

/** The skills ion passes to Claude Code: Claude's own folders, the shared one and ion's own. */
const FOR_CLAUDE: SkillWhose[] = ["claude", "shared", "ion"];
const OWNER: Record<SkillWhose, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
  shared: "Every agent",
  ion: "ion",
};

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * What you consent to when you turn a skill on: which skill, and exactly what's in it (SKILL.md and every file, and
 * which files run: a script's copy keeps its exec bit). Only an executable file adds its mark, so a skill without one
 * keeps the mark it had (final review, 2026-11-21).
 */
const material = (s: FoundSkill) =>
  `skill:${JSON.stringify([s.id, sha(s.md), ...s.files.map((f) => [f.rel, sha(f.bytes), ...(f.exec ? [1] : [])])])}`;

/** Your records: by skill id, the mark of what it was when you turned it on ("<id>@<mark>" in your config). */
const records = (on: string[]) =>
  new Map(on.map((e) => [e.slice(0, e.lastIndexOf("@")), e.slice(e.lastIndexOf("@") + 1)]));

type State = { on: boolean; new?: true; changed?: true };

/** On only while it's exactly what you turned on (its record verifies with ion's key); changed since: off. */
function stateOf(s: FoundSkill, was: string | undefined, now: string | undefined): State {
  if (!FOR_CLAUDE.includes(s.whose)) return { on: false };
  if (was === undefined) return { on: false, new: true };
  if (!now || !sameMark(was, now)) return { on: false, changed: true };
  return { on: true };
}

function supportOf(whose: SkillWhose, readers: SkillReaders): Record<string, "ion" | "own"> {
  const out: Record<string, "ion" | "own"> = {};
  for (const [id, r] of Object.entries(readers)) {
    if (r.fromIon && FOR_CLAUDE.includes(whose)) out[id] = "ion";
    else if (r.own.includes(whose)) out[id] = "own";
  }
  return out;
}

/** A skill as the Tools page shows it. */
function infoOf(s: FoundSkill, state: State, readers: SkillReaders): SkillInfo {
  const { id, name, description, whose, where } = s;
  return { id, name, description, whose, where, ...state, support: supportOf(whose, readers) };
}

export type Skills = ReturnType<typeof createSkills>;

/** ion's own skills folder: beside its config file and mcp.json (out of every run's reach, as they are). */
export const ionSkillsDir = (configFile: string): string => join(dirname(configFile), "skills");

/**
 * The skills your agents already have (found in each one's folders and your projects'), Claude Code's on or off: off
 * until you turn one on in the app, which is consent to exactly what it is now (signed with ion's own key); a skill
 * that changes is off again. A Claude Code run gets the ones on as a plugin made for it in ion's data folder.
 */
export function createSkills(o: {
  home: string;
  dataDir: string;
  sign: Sign;
  readers: SkillReaders;
  /** ion's own skills folder (beside mcp.json), where `ion skills add` copies one. */
  ionDir?: string;
}) {
  const find = (projects: string[]) => findSkills(o.home, projects, o.ionDir);
  const mark = (s: FoundSkill) => o.sign(material(s)).catch(() => undefined);
  /** The skills on; a run whose skills couldn't be checked (the keychain can't be read) is said in the log. */
  const turnedOn = async (found: FoundSkill[], on: string[]) => {
    const was = records(on);
    const marks = await Promise.all(found.map(mark));
    if (found.some((s, i) => was.has(s.id) && !marks[i]))
      console.warn(`skills skipped: ${CANT_READ_KEYCHAIN}`);
    return found.filter((s, i) => stateOf(s, was.get(s.id), marks[i]).on);
  };
  return {
    ionDir: o.ionDir,
    home: o.home,
    async list(on: string[], projects: string[]): Promise<SkillInfo[]> {
      const found = find(projects);
      const was = records(on);
      const marks = await Promise.all(found.map(mark));
      return found.map((s, i) => infoOf(s, stateOf(s, was.get(s.id), marks[i]), o.readers));
    },
    /** Your records with this skill turned on (as it is now) or off. */
    async turn(on: string[], id: string, turnOn: boolean, projects: string[]): Promise<string[]> {
      const kept = on.filter((e) => e.slice(0, e.lastIndexOf("@")) !== id);
      if (!turnOn) return kept;
      const s = find(projects).find((x) => x.id === id);
      if (!s) throw new UserError("Unknown skill");
      if (!FOR_CLAUDE.includes(s.whose)) throw new UserError(`${OWNER[s.whose]} uses its own`);
      const m = await mark(s);
      if (!m) throw new UserError(CANT_READ_KEYCHAIN);
      return [...kept, `${id}@${m}`];
    },
    /** A Claude Code run's plugin of the skills on (yours, and its project's), made afresh; null when none is on. */
    async forRun(r: { runId: string; on: string[]; projectDir: string | null }): Promise<string | null> {
      const dir = pluginDirOf(o.dataDir, r.runId);
      const found = find(r.projectDir ? [r.projectDir] : []);
      const given = await turnedOn(found, r.on);
      if (!given.length) {
        await rm(dir, { recursive: true, force: true });
        return null;
      }
      await writePlugin(dir, given);
      return dir;
    },
    /** A run's plugin, gone when the run ends. */
    remove: (runId: string) => rm(pluginDirOf(o.dataDir, runId), { recursive: true, force: true }),
    /** Plugins left by runs that never ended (ion stopped hard): gone when ion starts. */
    sweep: () => rmSync(join(o.dataDir, "skills"), { recursive: true, force: true }),
  };
}
