import { homedir } from "node:os";
import type { IonServers } from "../ions/servers.js";
import {
  byPreference,
  defaultAgent,
  getHarness,
  type HarnessEntry,
  harnessIds,
  listedHarnessIds,
} from "../adapters/registry.js";
import type { HarnessInfo } from "@ion/schema";
import type { AuthStatus } from "@ion/adapter-kit";
import type { Dreams } from "../scheduler/index.js";
import type { MemoryFiles } from "../memory/index.js";
import { chatDiff, createProject } from "../workspace/index.js";
import {
  addProject,
  loadUserConfig,
  removeProject,
  renameProject,
  saveUserConfig,
  setProjectStarred,
} from "@ion/config";
import { type Command, type Commands, DECISION_SCOPES, EV, type IonEvent } from "@ion/schema";
import type { Decisions } from "../decisions/index.js";
import { decisionsView } from "../views/decisions.js";
import type { Grants, RunScope } from "../mcp/index.js";
import type { Net } from "../secrets/oauth-net.js";
import type { Added, Seen } from "../tools/added.js";
import type { NeedsService } from "../needs/index.js";
import type { RunManager } from "../runs/manager.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { needsView } from "../views/needs.js";
import { UserError } from "./errors.js";
import { HarnessInfos } from "./harness-infos.js";
import { AgentSignIns } from "./harness-auth.js";
import { chatMemory, renameChat } from "../runs/ready.js";
import { projectPath } from "../runs/projects.js";
import { ionsView } from "../views/ions.js";
import type { Ions } from "../ions/service.js";
import { changeConfig, settingsHandlers } from "./settings.js";
import type { JudgeChecks } from "../access/judge-check.js";
import { workspaceHandlers } from "./workspace.js";
import { routineHandlers } from "./routines.js";
import { queueHandlers } from "./queue.js";
import { memoryHandlers, todoHandlers } from "./memory.js";
import type { PromptQueue } from "../queue/index.js";
import type { Routines } from "../scheduler/index.js";
import type { Suggestions } from "../ions/suggestions.js";
import type { Tools } from "../tools/index.js";
import type { OAuth } from "../secrets/oauth.js";
import type { Hooks } from "../hooks/index.js";
import type { Skills } from "../skills/index.js";
import { toolsHandlers } from "./tools.js";
import { toolsCliHandlers } from "./tools-cli.js";
import { toolsImportHandlers } from "./tools-import.js";
import { machineSandbox, notSandboxed } from "../runs/sandbox.js";
import { missesOf } from "../access/misses.js";
import { readAgentRules, ruleCount } from "../access/agent-rules.js";
import { orderIn, routed, usageNow } from "./routing.js";
import { estimateFor } from "./estimate.js";
import type { Handoffs } from "../runs/limit-handoff.js";

export { UserError } from "./errors.js";

/** How long `usage.list` waits on agents still being read (a fresh daemon). */
const USAGE_WAIT_MS = 4000;

/** What a chat changed in its worktree since it started (nothing once archived). */
export async function diffOfChat(ctx: { db: Db; configFile: string }, chatId: string) {
  const chat = chatsView.list(ctx.db).find((c) => c.chatId === chatId);
  if (!chat) throw new UserError(`Unknown chat: ${chatId}`);
  const worktree = chat.archived ? null : chatsView.worktree(ctx.db, chat.chatId);
  const project = loadUserConfig(ctx.configFile).config.projects.find((p) => p.id === chat.projectId);
  if (!worktree || !project) return { files: [] };
  return chatDiff(project.path, worktree);
}

/**
 * ask on the agent named, else the chat's own while it's ready; a new chat on the one Pick by usage picks (when it's
 * on; the chat says why), else the first ready in your agent order (never one signed out).
 */
async function askOn(a: Commands["ask"]["args"], ctx: Ctx) {
  if (a.harness) return ctx.runs.ask(a);
  const where = {
    ...(a.projectId ? { projectId: a.projectId } : {}),
    ...(a.effort ? { effort: a.effort } : {}),
    text: a.text,
  };
  const route = a.chatId ? null : await routed(ctx, () => harnessInfos.list(), where);
  if (route) return ctx.runs.ask({ ...a, harness: route.harness }, { routed: route.reason });
  const ready = (await harnessInfos.list()).filter((h) => h.installed && h.signedIn).map((h) => h.id);
  const own = a.chatId ? (chatsView.session(ctx.db, a.chatId)?.harness ?? null) : null;
  const harness = defaultAgent(ready, own, orderIn(ctx.configFile));
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
  /** Your memory and each project's: a folder of files, indexed. */
  memory: MemoryFiles;
  /** Your connections (mcp.json) and the keychain their keys and tokens are in. */
  tools: Tools;
  /** Signing in to remote servers (OAuth); their tokens are in the keychain. */
  oauth: OAuth;
  /** Your hooks on ion's events, and each one's last result. */
  hooks: Hooks;
  /** The skills your agents already have, Claude Code's on or off. */
  skills: Skills;
  /** How ion reaches the MCP Registry and package registries (public addresses only). */
  net: Net;
  /** Where what was added with ion's commands came from, and who added it. */
  added: Added;
  /** What Settings has shown as New. */
  seen: Seen;
  /** A chat's agent making this call (with its run's key); none: you. */
  caller?: RunScope;
  /** When a chat's agent hits its limit: ion's question, the handoff or the wait. */
  handoffs?: Handoffs;
  configFile: string;
  startedAt: number;
  version: string;
  /** Your servers for ions' turns, and each server's tools for "Ions can use". */
  ionServers?: IonServers;
  /** What Auto is often unsure about (said in `ion status`). */
  unsure?: { notes(): string[] };
  /** ion's dream: it tidies memory on its schedule, or now. */
  dreams?: Dreams;
  /** ion's checks of each agent's pinned judge model on this computer (PR #36 re-review, 2026-11-23). */
  judges?: JudgeChecks;
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
  ...memoryHandlers,
  ...todoHandlers,
  ...toolsHandlers,
  ...toolsCliHandlers,
  ...toolsImportHandlers,
  "needs.list": (a, ctx) => needsView.open(ctx.db, a.chatId),
  "chats.list": (_a, ctx) => chatsView.list(ctx.db),
  // What the app lists: the fake agent only in debug mode (ion itself still sees it, for tests and the tour).
  // In your agent order (Settings → Agents): the app's default agent is the first ready one.
  "harnesses.list": async (_a, ctx) => {
    const listed = byPreference(listedHarnessIds(), orderIn(ctx.configFile));
    const infos = await harnessInfos.list();
    return listed
      .map((id) => infos.find((h) => h.id === id))
      .filter((h) => !!h)
      .map(asListed);
  },
  // The user, 2026-11-23: sign in and out of each agent from ion (its own login and logout).
  "harness.login": (a) => signIns.login(String(a.id ?? ""), a.confirm === true),
  "harness.logout": (a, ctx) => signIns.logout(String(a.id ?? ""), a.confirm === true, ctx.db),
  "harness.cancelLogin": (a) => {
    signIns.cancel(String(a.id ?? ""));
    return { ok: true as const };
  },
  // The ready agents ion knows, waiting a few seconds at most on ones still being read (`ion status` stays quick).
  // A fresh daemon's agents are still being read: a few seconds for them, never longer (review, 2026-11-22).
  "usage.list": async (_a, ctx) => usageNow(ctx, await harnessInfos.settled(USAGE_WAIT_MS)),
  // What a task usually takes, from your past chats in its project (the brain pill's hover, an ion's thread line).
  "usage.estimate": async (a, ctx) => estimateFor(ctx, a, await harnessInfos.settled(USAGE_WAIT_MS)),
  "chat.diff": (a, ctx) => diffOfChat(ctx, String(a.chatId ?? "")),
  "chat.rename": (a, ctx) => {
    renameChat(ctx.store, ctx.db, String(a.chatId ?? ""), String(a.title ?? ""));
    return { ok: true as const };
  },
  // Don't remember (off) or Remember (on) a chat, from its menu (the user, 2026-11-23).
  "chat.remember": (a, ctx) => {
    if (typeof a.on !== "boolean") throw new UserError("Pick on or off");
    chatMemory(ctx.store, ctx.db, String(a.chatId ?? ""), a.on);
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
    const needId = String(a.needId ?? "");
    // ion's own question when a chat's agent hit its limit: Continue, Wait or Always.
    if (ctx.handoffs?.owns(needId)) await ctx.handoffs.answer(needId, pick, scope);
    else await ctx.decisions.answer(needId, pick, scope);
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
    if (chatId) ctx.handoffs?.stopWaiting(chatId); // a chat waiting for its agent's reset stops waiting, for good
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
      notes: ctx.unsure?.notes() ?? [],
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
    await ctx.ions.message(ionId, text, {
      ...(a.skills ? { skills: a.skills } : {}),
      ...(a.mentions ? { mentions: a.mentions } : {}),
    });
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
    ctx.memory.forgetProject(id, "you");
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

/** Sign-ins ion started, and each agent read again once one ends or it signs out. */
const signIns = new AgentSignIns({ refresh: (id) => harnessInfos.refresh(id) });

/** ion is stopping: every sign-in it started is stopped (review of #35, 2026-11-23). */
export const stopSignIns = (): Promise<void> => signIns.stopAll();

/** An agent as the app lists it: how often its judge missed, and the sign-in ion is waiting on. */
export const asListed = (h: HarnessInfo): HarnessInfo => ({
  ...h,
  ...missesOf(h.id),
  ...signIns.pageOf(h.id),
});

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

/** Where your agents' configs are (set once when ion starts: ION_AGENTS_HOME in the tour). */
let agentsDir = homedir();
export const useAgentsHome = (home: string): void => {
  agentsDir = home;
};

/** How many of its own allow and deny rules (your settings for it) ion goes by in its chats. */
function ownRulesOf(id: string): { ownRules?: number } {
  const n = ruleCount(readAgentRules(id, { home: agentsDir }));
  return n ? { ownRules: n } : {};
}

async function readyInfo(id: string, h: NonNullable<ReturnType<typeof getHarness>>): Promise<HarnessInfo> {
  const installed = (await h.adapter.detect()).installed;
  const auth = installed ? await h.adapter.auth.status() : null;
  const signedIn = !!auth?.signedIn;
  const caps = signedIn ? await h.adapter.capabilities() : null;
  return {
    id,
    label: h.label,
    installed,
    signedIn,
    models: caps?.models ?? [],
    defaultModel: caps?.defaultModel ?? null,
    ...(h.adapter.ownTools ? { ownTools: true as const } : {}),
    ...(h.adapter.ownHooks ? { ownHooks: true as const } : {}),
    ...(h.adapter.ownOff ? { ownOff: h.adapter.ownOff } : {}),
    ...(h.adapter.ownTrust ? { ownTrust: true as const } : {}),
    ...(notSandboxed(h.adapter.sandbox, machineSandbox()) ? { notSandboxed: true as const } : {}),
    ...ownRulesOf(id),
    ...billingOf(auth),
    ...(auth?.unknown ? { signInUnknown: true as const } : {}),
    ...signInOf(h.adapter.auth),
  };
}

/** How you sign in and out: its own commands, and whether ion runs them. */
function signInOf(auth: HarnessEntry["adapter"]["auth"]): Pick<HarnessInfo, "signIn" | "signOut"> {
  return {
    signIn: {
      command: auth.login.command,
      inApp: !!auth.login.start,
      ...(auth.login.clears ? { clears: true } : {}),
    },
    signOut: { command: auth.logout.command, inApp: !!auth.logout.run },
  };
}

/** How it bills, from its sign-in (only when signed in: a sign-in that isn't there bills nothing). */
function billingOf(auth: AuthStatus | null): Pick<HarnessInfo, "billing"> {
  return auth?.signedIn && auth.billing ? { billing: auth.billing } : {};
}
