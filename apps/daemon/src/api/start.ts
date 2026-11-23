import { DEFAULT_PROJECT, ionPaths, loadUserConfig, saveUserConfig } from "@ion/config";
import type { HarnessInfo } from "@ion/schema";
import { ionDirsOf } from "../access/index.js";
import { agentLabel } from "../adapters/registry.js";
import { stepOf } from "../runs/agent-steps.js";
import { chatsView } from "../views/chats.js";
import { addFolder } from "../workspace/index.js";
import type { Handlers } from "./commands.js";
import { AskFirst, UserError } from "./errors.js";

/** `fresh`: each agent read again now; `waitMs`: what's known, waiting that long at most for first reads. */
export type ListOpts = { fresh?: boolean; waitMs?: number };

/** The agents the app lists, in your order (`ids`), and what ion knows of them (`agents`). */
type Agents = {
  agents: (configFile: string, o?: ListOpts) => Promise<HarnessInfo[]>;
  ids: (configFile: string) => string[];
};

/** How long `start.status` waits for a fresh daemon's first reads of the agents (the tour, 2026-11-23: bare `ion` waited 60 s on opencode). */
const WAIT_MS = 4000;

/**
 * A first run (Plan 21): what it needs to know, and adding your folder. `start.status` counts your own projects (not
 * ion's `default`) and every chat (archived too): with none of either, the app opens on its first-run screen.
 */
export const startHandlers = (a: Agents): Pick<Handlers, "start.status" | "projects.add"> => ({
  "start.status": async (args, ctx) => {
    const projects = loadUserConfig(ctx.configFile).config.projects.filter(
      (p) => p.id !== DEFAULT_PROJECT,
    ).length;
    const chats = chatsView.list(ctx.db).length;
    const known = await a.agents(ctx.configFile, { fresh: args.fresh === true, waitMs: WAIT_MS });
    // One still being read says so, rather than holding the answer.
    const steps = a.ids(ctx.configFile).map((id) => {
      const h = known.find((x) => x.id === id);
      return h ? stepOf(h) : { id, label: agentLabel(id), state: "checking" as const };
    });
    return { agents: steps, projects, chats, firstRun: !projects && !chats };
  },
  // Plan 21 audit, 2026-11-23: a folder that isn't a git repo was refused with no fix; it gets ion's git setup now,
  // once you say yes (review of Plan 21 Task 2, 2026-11-23).
  "projects.add": async (args, ctx) => {
    const { config, error } = loadUserConfig(ctx.configFile);
    if (error) throw new UserError(`Fix your config first. ${error}`);
    // ion's own folders, from the one list the sandbox and the gate use too (security scan of 3864449, 2026-11-23).
    const ionDirs = ionDirsOf({ dataDir: ctx.dataDir ?? ionPaths().dataDir, configFile: ctx.configFile });
    const added = await addFolder(config, String(args.path ?? ""), {
      ionDirs,
      confirm: args.confirm === true,
    }).catch((e: Error) => {
      throw new UserError(e.message);
    });
    if ("ask" in added) throw new AskFirst(added.ask);
    saveUserConfig(ctx.configFile, added.config);
    const project = added.config.projects[added.config.projects.length - 1]!;
    return added.gitSetUp ? { ...project, gitSetUp: added.gitSetUp } : project;
  },
});
