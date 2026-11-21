import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FoundSkill } from "./find.js";

const RUN_ID = /^[\w-]{1,100}$/;

/** Where a run's skills plugin is made: in ion's data folder, never in the chat's worktree. */
export function pluginDirOf(dataDir: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error("Not a run id");
  return join(dataDir, "skills", runId);
}

/** A folder name Claude Code takes for a skill: lowercase letters, digits and dashes. */
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter(Boolean)
    .join("-")
    .slice(0, 64) || "skill";

/**
 * SKILL.md as passed: its name and description only in the front matter, so no `allowed-tools` (they'd skip asking)
 * and no `hooks` of its own; then its text as written.
 */
const skillMd = (name: string, s: FoundSkill) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(s.description)}\n---\n${s.body}`;

/**
 * Writes a Claude Code plugin of these skills to `dir` (`.claude-plugin/plugin.json` and `skills/<name>/`), made
 * afresh: whatever was there before is removed first. Only you can read it.
 */
export async function writePlugin(dir: string, skills: FoundSkill[]): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, ".claude-plugin"), { recursive: true, mode: 0o700 });
  const manifest = { name: "ion-skills", version: "0.0.0", description: "The skills you turned on in ion" };
  await writeFile(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest), { mode: 0o600 });
  const used = new Set<string>();
  for (const s of skills) {
    const base = slug(s.name);
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base.slice(0, 60)}-${n++}`;
    used.add(name);
    const root = join(dir, "skills", name);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "SKILL.md"), skillMd(name, s), { mode: 0o600 });
    for (const f of s.files) {
      await mkdir(dirname(join(root, f.rel)), { recursive: true, mode: 0o700 });
      // A script stays runnable (0700 when the source was executable), only by you.
      await writeFile(join(root, f.rel), f.bytes, { mode: f.exec ? 0o700 : 0o600 });
    }
  }
}
