import { loadUserConfig } from "@ion/config";
import { takesSkills } from "../adapters/registry.js";
import type { Skills } from "./index.js";

/** A chat run's skills: made at its start for its agent and project, removed when it ends. */
export type RunSkills = {
  forRun(r: { runId: string; harness: string; projectId: string }): Promise<string | null>;
  remove(runId: string): Promise<void>;
};

/** Your skills for chat runs: the ones on, as a plugin, for an agent ion passes skills to (Claude Code); else none. */
export function runSkillsOf(skills: Skills, configFile: string): RunSkills {
  return {
    async forRun(r) {
      if (!takesSkills(r.harness)) return null;
      const { config } = loadUserConfig(configFile);
      const projectDir = config.projects.find((p) => p.id === r.projectId)?.path ?? null;
      return skills.forRun({ runId: r.runId, on: config.tools.skills.on, projectDir });
    },
    remove: (runId) => skills.remove(runId),
  };
}

/** A run's skills plugin; one ion can't make is said in the daemon's log and the run goes on without it. */
export const skillsFor = (
  skills: RunSkills | undefined,
  l: { runId: string; projectId: string; h: { adapter: { id: string } } },
) =>
  skills?.forRun({ runId: l.runId, harness: l.h.adapter.id, projectId: l.projectId }).catch((e: Error) => {
    console.warn(`skills: a run's skills couldn't be given: ${e.name}`);
    return null;
  });
