import { addProject, loadUserConfig, saveUserConfig } from "@ion/config";
import { type Command, type Commands, EV, type IonEvent } from "@ion/schema";
import type { NeedsService } from "../needs/index.js";
import type { RunManager } from "../runs/manager.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { needsView } from "../views/needs.js";
import { UserError } from "./errors.js";

export { UserError } from "./errors.js";

export type Ctx = {
  store: EventStore;
  db: Db;
  needs: NeedsService;
  runs: RunManager;
  configFile: string;
  startedAt: number;
  version: string;
};

type Handlers = {
  [C in Exclude<Command, "events.subscribe">]: (
    args: Commands[C]["args"],
    ctx: Ctx,
  ) => Commands[C]["result"] | Promise<Commands[C]["result"]>;
};

export const handlers: Handlers = {
  "needs.list": (a, ctx) => needsView.open(ctx.db, a.chatId),
  "chats.list": (_a, ctx) => chatsView.list(ctx.db),
  "chat.archive": async (a, ctx) => {
    await ctx.runs.archive(String(a.chatId ?? ""));
    return { ok: true as const };
  },
  "need.resolve": (a, ctx) => {
    const decision = a.decision;
    if (decision !== "allow" && decision !== "allow_always" && decision !== "deny")
      throw new UserError("Answer allow or deny");
    ctx.needs.resolve(String(a.needId ?? ""), decision, "you");
    return { ok: true as const };
  },
  ask: (a, ctx) => {
    if (typeof a.text !== "string" || !a.text.trim()) throw new UserError("Say what to do");
    return ctx.runs.ask(a);
  },
  "run.interrupt": async (a, ctx) => {
    await ctx.runs.interrupt(String(a.runId ?? ""));
    return { ok: true as const };
  },
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
