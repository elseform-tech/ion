import { getHarness, harnessIds } from "../adapters/registry.js";
import type { HarnessInfo } from "@ion/schema";
import { forgetMemory } from "../memory/index.js";
import { chatDiff, createProject } from "../workspace/index.js";
import { memoryView } from "../views/memory.js";
import {
  addProject,
  loadUserConfig,
  removeProject,
  renameProject,
  saveUserConfig,
  setProjectAccess,
  setProjectStarred,
  type UserConfig,
} from "@ion/config";
import { type Command, type Commands, DECISION_SCOPES, EV, type IonEvent } from "@ion/schema";
import type { Decisions } from "../decisions/index.js";
import { decisionsView } from "../views/decisions.js";
import type { Grants } from "../mcp/index.js";
import type { NeedsService } from "../needs/index.js";
import type { RunManager } from "../runs/manager.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { needsView } from "../views/needs.js";
import { UserError } from "./errors.js";
import { HarnessInfos } from "./harness-infos.js";
import { renameChat } from "../runs/ready.js";
import { ionsView } from "../views/ions.js";
import type { Ions } from "../ions/service.js";

export { UserError } from "./errors.js";

export type Ctx = {
  store: EventStore;
  db: Db;
  needs: NeedsService;
  decisions: Decisions;
  grants: Grants;
  runs: RunManager;
  ions: Ions;
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
  "harnesses.list": () => harnessInfos.list(),
  "memory.list": (a, ctx) => memoryView.list(ctx.db, a.projectId ?? null),
  "memory.forget": (a, ctx) => {
    forgetMemory(ctx.store, ctx.db, String(a.memoryId ?? ""));
    return { ok: true as const };
  },
  "chat.diff": async (a, ctx) => {
    const chat = chatsView.list(ctx.db).find((c) => c.chatId === a.chatId);
    if (!chat) throw new UserError(`Unknown chat: ${String(a.chatId)}`);
    const worktree = chat.archived ? null : chatsView.worktree(ctx.db, chat.chatId);
    const project = loadUserConfig(ctx.configFile).config.projects.find((p) => p.id === chat.projectId);
    if (!worktree || !project) return { files: [] };
    return chatDiff(project.path, worktree);
  },
  "chat.rename": (a, ctx) => {
    renameChat(ctx.store, ctx.db, String(a.chatId ?? ""), String(a.title ?? ""));
    return { ok: true as const };
  },
  "chat.archive": async (a, ctx) => {
    await ctx.runs.archive(String(a.chatId ?? ""));
    return { ok: true as const };
  },
  "need.answer": async (a, ctx) => {
    const scope = a.scope ?? "chat";
    if (!DECISION_SCOPES.includes(scope)) throw new UserError("Pick chat, project or everywhere");
    const pick = typeof a.text === "string" ? a.text : Number(a.choice);
    await ctx.decisions.answer(String(a.needId ?? ""), pick, scope);
    return { ok: true as const };
  },
  "decisions.list": (a, ctx) => decisionsView.list(ctx.db, a.projectId),
  "decision.note": (a, ctx) => {
    const text = String(a.text ?? "").trim();
    if (!text) throw new UserError("Say what happened");
    ctx.decisions.note(String(a.decisionId ?? ""), text.slice(0, 2000));
    return { ok: true as const };
  },
  "decision.forget": (a, ctx) => {
    ctx.decisions.forget(String(a.decisionId ?? ""));
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
  "ions.list": (_a, ctx) => ionsView.list(ctx.db, loadUserConfig(ctx.configFile).config.projects),
  "ion.message": async (a, ctx) => {
    const text = String(a.text ?? "").trim();
    if (!text) throw new UserError("Say something");
    await ctx.ions.message(String(a.ionId ?? ""), text);
    return { ok: true as const };
  },
  "suggestion.answer": (a, ctx) => {
    ctx.decisions.suggestion(String(a.suggestionId ?? ""), a.keep === true);
    return { ok: true as const };
  },
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
  "project.create": async (a, ctx) => {
    const { config, error } = loadUserConfig(ctx.configFile);
    if (error) throw new UserError(`Fix your config first. ${error}`);
    const made = await createProject(config, String(a.name ?? "")).catch((e: Error) => {
      throw new UserError(e.message);
    });
    saveUserConfig(ctx.configFile, made.config);
    return made.config.projects.find((p) => p.id === made.id)!;
  },
  "project.rename": (a, ctx) => {
    changeConfig(ctx.configFile, (c) => renameProject(c, String(a.projectId ?? ""), String(a.name ?? "")));
    return { ok: true as const };
  },
  "project.remove": async (a, ctx) => {
    const id = String(a.projectId ?? "");
    // Refuses default and an unknown project before anything is archived.
    changeConfig(ctx.configFile, (c) => (removeProject(c, id), c));
    const chats = chatsView.list(ctx.db).filter((c) => c.projectId === id && !c.archived);
    if (chats.some((c) => ["queued", "running"].includes(c.lastRunStatus ?? "")))
      throw new UserError("Stop its running chats first");
    for (const c of chats) await ctx.runs.archive(c.chatId);
    // What you decided for it, and what ion remembers of it, go with it: a later project of the same id starts clean.
    for (const d of decisionsView.list(ctx.db, id)) ctx.decisions.forget(d.decisionId);
    for (const m of memoryView.list(ctx.db, id))
      if (m.scope === id) forgetMemory(ctx.store, ctx.db, m.memoryId);
    changeConfig(ctx.configFile, (c) => removeProject(c, id));
    return { ok: true as const };
  },
  "project.star": (a, ctx) => {
    const { config, error } = loadUserConfig(ctx.configFile);
    if (error) throw new UserError(`Fix your config first. ${error}`);
    try {
      saveUserConfig(
        ctx.configFile,
        setProjectStarred(config, String(a.projectId ?? ""), a.starred === true),
      );
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    return { ok: true as const };
  },
  "project.setAccess": (a, ctx) => {
    const access = a.access;
    if (access !== "auto" && access !== "full") throw new UserError("Pick auto or full");
    const { config, error } = loadUserConfig(ctx.configFile);
    if (error) throw new UserError(`Fix your config first. ${error}`);
    try {
      saveUserConfig(ctx.configFile, setProjectAccess(config, String(a.projectId ?? ""), access));
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    return { ok: true as const };
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

/** Loads your config, changes it, saves it; a refusal (or a config that doesn't parse) is the error you see. */
function changeConfig(file: string, change: (c: UserConfig) => UserConfig): void {
  const { config, error } = loadUserConfig(file);
  if (error) throw new UserError(`Fix your config first. ${error}`);
  try {
    saveUserConfig(file, change(config));
  } catch (e) {
    throw new UserError((e as Error).message);
  }
}

/** Every agent's info, kept and read again in the background (asking each CLI takes seconds). */
export const harnessInfos = new HarnessInfos(harnessIds, harnessInfo, { maxAgeMs: 60_000 });

/** A harness, whether it's ready, and (only when it is) its own model list. */

async function harnessInfo(id: string): Promise<HarnessInfo> {
  const h = getHarness(id)!;
  // One harness that fails to answer shows as not ready; it doesn't break the list.
  return readyInfo(id, h).catch(() => ({
    id,
    label: h.label,
    installed: false,
    signedIn: false,
    models: [],
    defaultModel: null,
  }));
}

async function readyInfo(id: string, h: NonNullable<ReturnType<typeof getHarness>>): Promise<HarnessInfo> {
  const installed = (await h.adapter.detect()).installed;
  const signedIn = installed && (await h.adapter.auth.status()).signedIn;
  const caps = signedIn ? await h.adapter.capabilities() : null;
  return {
    id,
    label: h.label,
    installed,
    signedIn,
    models: caps?.models ?? [],
    defaultModel: caps?.defaultModel ?? null,
  };
}
