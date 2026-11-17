import { addProject, loadUserConfig, saveUserConfig } from "@ion/config";
import { type Command, type Commands, EV, type IonEvent } from "@ion/schema";
import type { EventStore } from "../store/index.js";

export type Ctx = { store: EventStore; configFile: string; startedAt: number; version: string };

/** Errors whose message is safe and useful to show the user. */
export class UserError extends Error {}

/** Commands that start or stop runs; the run manager handles them (Plan 02, Task 7). */
type RunCommand = "ask" | "run.interrupt";

type Handlers = {
  [C in Exclude<Command, "events.subscribe" | RunCommand>]: (
    args: Commands[C]["args"],
    ctx: Ctx,
  ) => Commands[C]["result"];
};

export const handlers: Handlers = {
  status: (_a, ctx) => {
    const { config, error } = loadUserConfig(ctx.configFile);
    return {
      version: ctx.version,
      pid: process.pid,
      uptimeS: Math.round((Date.now() - ctx.startedAt) / 1000),
      projects: config.projects.length,
      configError: error,
    };
  },
  "projects.list": (_a, ctx) => loadUserConfig(ctx.configFile).config.projects,
  "projects.add": (a, ctx) => {
    const { config, error } = loadUserConfig(ctx.configFile);
    if (error) throw new UserError(`Fix your config first. ${error}`);
    let next: typeof config;
    try {
      next = addProject(config, String(a.path ?? ""));
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    saveUserConfig(ctx.configFile, next);
    return next.projects[next.projects.length - 1]!;
  },
  "chat.create": (a, ctx): IonEvent =>
    ctx.store.append({
      chatId: `chat_${crypto.randomUUID()}`,
      runId: null,
      origin: "daemon",
      type: EV.chatCreated,
      data: { title: String(a.title ?? "New chat"), projectId: a.projectId ?? null },
    }),
};
