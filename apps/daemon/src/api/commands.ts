import { defaultAgent, getHarness, harnessIds, listedHarnessIds } from "../adapters/registry.js";
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
import { projectPath } from "../runs/projects.js";
import { ionsView } from "../views/ions.js";
import type { Ions } from "../ions/service.js";
import { changeConfig, settingsHandlers } from "./settings.js";
import { workspaceHandlers } from "./workspace.js";
import { routineHandlers } from "./routines.js";
import { queueHandlers } from "./queue.js";
import type { PromptQueue } from "../queue/index.js";
import type { Routines } from "../scheduler/index.js";
import type { Suggestions } from "../ions/suggestions.js";

export { UserError } from "./errors.js";

/** What a chat changed in its worktree since it started (nothing once archived). */
export async function diffOfChat(ctx: { db: Db; configFile: string }, chatId: string) {
  const chat = chatsView.list(ctx.db).find((c) => c.chatId === chatId);
  if (!chat) throw new UserError(`Unknown chat: ${chatId}`);
  const worktree = chat.archived ? null : chatsView.worktree(ctx.db, chat.chatId);
  const project = loadUserConfig(ctx.configFile).config.projects.find((p) => p.id === chat.projectId);
  if (!worktree || !project) return { files: [] };
  return chatDiff(project.path, worktree);
}

/** ask on the agent named, else the chat's own while it's ready, else the first ready one (never one signed out). */
async function askOn(a: Commands["ask"]["args"], ctx: Ctx) {
  if (a.harness) return ctx.runs.ask(a);
  const ready = (await harnessInfos.list()).filter((h) => h.installed && h.signedIn).map((h) => h.id);
  const own = a.chatId ? (chatsView.session(ctx.db, a.chatId)?.harness ?? null) : null;
  const harness = defaultAgent(ready, own);
  if (!harness) throw new UserError("No agent is signed in. See Settings → Agents.");
  return ctx.runs.ask({ ...a, harness });
}

export type Ctx = {
  store: EventStore;
  db: Db;
  needs: NeedsService;
  decisions: Decisions;
  grants: Grants;
  runs: RunManager;
  ions: Ions;
  routines: Routines;
  suggestions: Suggestions;
  queue: PromptQueue;
  configFile: string;
  startedAt: number;
  version: string;
};

export type Handlers = {
  [C in Exclude<Command, "events.subscribe">]: (
    args: Commands[C]["args"],
    ctx: Ctx,
  ) => Commands[C]["result"] | Promise<Commands[C]["result"]>;
};

export const handlers: Handlers = {
  ...settingsHandlers,
  ...workspaceHandlers,
  ...routineHandlers,
  ...queueHandlers,
  "needs.list": (a, ctx) => needsView.open(ctx.db, a.chatId),
  "chats.list": (_a, ctx) => chatsView.list(ctx.db),
  // What the app lists: the fake agent only in debug mode (ion itself still sees it, for tests and the tour).
  "harnesses.list": async (_a, ctx) => {
    const listed = listedHarnessIds(loadUserConfig(ctx.configFile).config.debug);
    return (await harnessInfos.list()).filter((h) => listed.includes(h.id));
  },
  "memory.list": (a, ctx) => memoryView.list(ctx.db, a.projectId ?? null),
  "memory.forget": (a, ctx) => {
    forgetMemory(ctx.store, ctx.db, String(a.memoryId ?? ""));
    return { ok: true as const };
  },
  "chat.diff": (a, ctx) => diffOfChat(ctx, String(a.chatId ?? "")),
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
  ask: async (a, ctx) => {
    if (typeof a.text !== "string" || !a.text.trim()) throw new UserError("Say what to do");
    const r = await askOn(a, ctx);
    // You sent a message: what you queued for the chat (held after a stop) goes on after it.
    if (a.chatId) ctx.queue.goOn({ chatId: a.chatId });
    return r;
  },
  "run.interrupt": async (a, ctx) => {
    const runId = String(a.runId ?? "");
    // You stopped it (Stop, Esc twice): what's queued for the chat waits for you.
    const chatId = ctx.store.read({ runId, limit: 1 })[0]?.chatId;
    if (chatId) ctx.queue.hold({ chatId });
    await ctx.runs.interrupt(runId);
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
  "ions.list": (_a, ctx) =>
    ionsView.list(ctx.db, loadUserConfig(ctx.configFile).config.projects, (ionId) => ctx.ions.busy(ionId)),
  "ion.message": async (a, ctx) => {
    const text = String(a.text ?? "").trim();
    if (!text) throw new UserError("Say something");
    const ionId = String(a.ionId ?? "");
    // You sent a message: what you queued for the ion (held after a stop) goes on after it.
    ctx.queue.goOn({ ionId });
    await ctx.ions.message(ionId, text);
    return { ok: true as const };
  },
  // ion chief's own suggestions (a routine, a stalled chat), else a project ion's "always?".
  "suggestion.answer": async (a, ctx) => {
    const id = String(a.suggestionId ?? "");
    if (ctx.suggestions.owns(id))
      await ctx.suggestions.answer(id, { keep: a.keep === true, mute: a.mute === true });
    else ctx.decisions.suggestion(id, a.keep === true);
    return { ok: true as const };
  },
  "suggestions.list": (_a, ctx) => ctx.suggestions.list(),
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
    // Out of your config first, so nothing (a routine, an ion message) starts in it while it goes.
    const repo = projectPath(ctx.configFile, id);
    changeConfig(ctx.configFile, (c) => removeProject(c, id));
    for (const c of chats) await ctx.runs.archive(c.chatId, repo);
    // Its ion is gone: what you queued for it goes too.
    ctx.queue.clear({ ionId: id });
    // What you decided for it, and what ion remembers of it, go with it: a later project of the same id starts clean.
    for (const d of decisionsView.list(ctx.db, id)) ctx.decisions.forget(d.decisionId);
    for (const m of memoryView.list(ctx.db, id))
      if (m.scope === id) forgetMemory(ctx.store, ctx.db, m.memoryId);
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
