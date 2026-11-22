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

/** By agent id: its "Use its own tools" switch (on unless you turned it off). */
export type OwnSwitches = Record<string, boolean>;
/** Only what you turned on in ion counts (a run's own skills are added on their own). */
const BY_CONSENT: OwnSwitches = { "claude-code": false };

/**
 * The agent whose own a skill is: Codex's and opencode's always (they read them themselves); Claude Code's in your home
 * while it brings its own. A project's .claude/skills is the repo's (security review, 2026-11-21): ion passes it only
 * once you turn it on.
 */
function ownerOf(s: Pick<FoundSkill, "whose" | "project">, own: OwnSwitches): string | undefined {
  if (s.whose === "claude") return own["claude-code"] !== false && !s.project ? "claude-code" : undefined;
  return s.whose === "codex" || s.whose === "opencode" ? s.whose : undefined;
}

/** On only while it's exactly what you turned on (its record verifies with ion's key); changed since: off. */
function stateOf(s: FoundSkill, was: string | undefined, now: string | undefined, own: OwnSwitches): State {
  // Claude Code's own, while it brings its own: on, as it is (the user, 2026-11-21).
  if (s.whose === "claude" && ownerOf(s, own)) return { on: true };
  if (!FOR_CLAUDE.includes(s.whose)) return { on: false };
  if (was === undefined) return { on: false, new: true };
  if (!now || !sameMark(was, now)) return { on: false, changed: true };
  return { on: true };
}

function supportOf(s: FoundSkill, readers: SkillReaders, own: OwnSwitches): Record<string, "ion" | "own"> {
  const { whose } = s;
  const out: Record<string, "ion" | "own"> = {};
  if (ownerOf(s, own) === "claude-code") return { "claude-code": "own" };
  for (const [id, r] of Object.entries(readers)) {
    if (r.fromIon && FOR_CLAUDE.includes(whose)) out[id] = "ion";
    else if (r.own.includes(whose)) out[id] = "own";
  }
  return out;
}

/** Agents that read a project's skill folders themselves (by their own trust); opencode's external skills are off. */
const READS_PROJECTS = new Set(["codex"]);

/**
 * The agents that load a skill themselves (task review, 2026-11-21): Claude Code its home skills while it brings its
 * own; each other agent the folders it reads (a project's only where it reads them by its own trust).
 */
function readersOf(s: FoundSkill, readers: SkillReaders, own: OwnSwitches): string[] {
  const out = ownerOf(s, own) === "claude-code" ? ["claude-code"] : [];
  for (const [id, r] of Object.entries(readers))
    if (r.own.includes(s.whose) && (!s.project || READS_PROJECTS.has(id))) out.push(id);
  return out;
}

/** What's in a skill (SKILL.md and its files), short. */
const hashOf = (s: FoundSkill) =>
  createHash("sha256")
    .update(JSON.stringify([sha(s.md), ...s.files.map((f) => [f.rel, sha(f.bytes)])]))
    .digest("hex")
    .slice(0, 12);

/** A skill as the Tools page shows it: whose own it is (read-only there), and what's in it (to match it elsewhere). */
function infoOf(s: FoundSkill, state: State, readers: SkillReaders, own: OwnSwitches): SkillInfo {
  const { id, name, description, whose, where, project } = s;
  const owner = ownerOf(s, own);
  const hash = hashOf(s);
  return {
    ...{ id, name, description, whose, where, ...state, hash },
    support: supportOf(s, readers, own),
    ...(owner ? { own: owner } : {}),
    ...(project ? { project } : {}),
    readers: readersOf(s, readers, own),
  };
}

export type Skills = ReturnType<typeof createSkills>;

type Listed = Pick<SkillInfo, "id" | "hash" | "on" | "own">;

/** A listed skill's text, from the skills found: that exact one (folder and contents), while it's on or own. */
function bodyFrom(found: FoundSkill[], s: Listed): string | null {
  if (!s.on && !s.own) return null;
  const f = found.find((x) => x.id === s.id);
  return f && hashOf(f) === s.hash ? f.body : null;
}

/** ion's own skills folder: beside its config file and mcp.json (out of every run's reach, as they are). */
export const ionSkillsDir = (configFile: string): string => join(dirname(configFile), "skills");

/** A chat run's skills: yours that are on, and (`own`) Claude Code's own as they are. */
type SkillsForRun = { runId: string; on: string[]; projectDir: string | null; own?: boolean };

/** Your records with a skill turned on (consent to it as it is now, signed) or off; an agent's own has no switch. */
async function turnSkill(
  t: { on: string[]; id: string; turnOn: boolean; own: OwnSwitches },
  found: FoundSkill[],
  mark: (s: FoundSkill) => Promise<string | undefined>,
): Promise<string[]> {
  const kept = t.on.filter((e) => e.slice(0, e.lastIndexOf("@")) !== t.id);
  const s = found.find((x) => x.id === t.id);
  if (s && ownerOf(s, t.own)) throw new UserError(`${OWNER[s.whose]} uses its own`);
  if (!t.turnOn) return kept;
  if (!s) throw new UserError("Unknown skill");
  if (!FOR_CLAUDE.includes(s.whose)) throw new UserError(`${OWNER[s.whose]} uses its own`);
  const m = await mark(s);
  if (!m) throw new UserError(CANT_READ_KEYCHAIN);
  return [...kept, `${t.id}@${m}`];
}

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
    return found.filter((s, i) => stateOf(s, was.get(s.id), marks[i], BY_CONSENT).on);
  };
  return {
    ionDir: o.ionDir,
    home: o.home,
    async list(on: string[], projects: string[], own: OwnSwitches = BY_CONSENT): Promise<SkillInfo[]> {
      const found = find(projects);
      const was = records(on);
      const marks = await Promise.all(found.map(mark));
      return found.map((s, i) => infoOf(s, stateOf(s, was.get(s.id), marks[i], own), o.readers, own));
    },
    /** Your records with this skill turned on (as it is now) or off; an agent's own has no switch. */
    turn: (on: string[], id: string, turnOn: boolean, at: { projects: string[]; own?: OwnSwitches }) =>
      turnSkill({ on, id, turnOn, own: at.own ?? BY_CONSENT }, find(at.projects), mark),
    /** A Claude Code run's plugin of the skills on (yours, its project's, its own), made afresh; null when none is on. */
    async forRun(r: SkillsForRun): Promise<string | null> {
      const dir = pluginDirOf(o.dataDir, r.runId);
      const found = find(r.projectDir ? [r.projectDir] : []);
      // Claude Code's own skills come as they are while it brings its own (its settings files never load).
      const own = r.own ? found.filter((s) => ownerOf(s, { "claude-code": true }) === "claude-code") : [];
      const yours = await turnedOn(
        found.filter((s) => !own.includes(s)),
        r.on,
      );
      const given = [...own, ...yours];
      if (!given.length) {
        await rm(dir, { recursive: true, force: true });
        return null;
      }
      await writePlugin(dir, given);
      return dir;
    },
    /**
     * A listed skill's SKILL.md after its front matter: only the exact skill listed (its folder and what's in it, as
     * checked), only while it's on or an agent's own (security review, 2026-11-21); else null.
     */
    bodyOf: (projects: string[], s: Listed) => bodyFrom(find(projects), s),
    /** A run's plugin, gone when the run ends. */
    remove: (runId: string) => rm(pluginDirOf(o.dataDir, runId), { recursive: true, force: true }),
    /** Plugins left by runs that never ended (ion stopped hard): gone when ion starts. */
    sweep: () => rmSync(join(o.dataDir, "skills"), { recursive: true, force: true }),
  };
}
