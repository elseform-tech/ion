import type { EffortLevel } from "@ion/schema";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DEFAULT_PROJECT,
  loadUserConfig,
  PROFILE_CHARS,
  type ProjectEntry,
  saveUserConfig,
} from "@ion/config";
import type { ChatInfo, HarnessInfo } from "@ion/schema";
import { z } from "zod";
import { UserError } from "../api/errors.js";
import { wrapData } from "../context/index.js";
import { contextOf } from "../ions/route.js";
import { cleanProfile, profileOf, rankProjects } from "../ions/profiles.js";
import { PER_TURN } from "../ions/turn.js";
import type { Db } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { decisionsView } from "../views/decisions.js";
import { messagesView } from "../views/messages.js";
import { needsView } from "../views/needs.js";
import { decisionLine } from "./ask.js";
import type { IonScope } from "./grants.js";
import { registerYourTools, type YourTools } from "./ion-your-tools.js";
import { brainArgs, registerChatsTool } from "./ion-chats-tool.js";
import { guard, ok, q } from "./result.js";
import { registerMemoryTools } from "./memory-tools.js";
import { DREAM_ION } from "../memory/dream-rules.js";
import { ionCaller, ionMemory, leastIonMemory } from "../memory/switch.js";
import { type Deps, historyData, needsData, SEARCH_MAX, searchData } from "./tools.js";

/** Skills and servers a thread starts with, by name (the user, 2026-11-21: "/" and "@" for ions too). */
/**
 * What an ion passes with a thread: the skills and connections to use, and (only when you asked for this chat) the
 * agent, model and effort it runs on (the user, 2026-11-24).
 */
export type ThreadPicks = {
  skills?: string[];
  mentions?: string[];
  harness?: string;
  model?: string;
  effort?: EffortLevel;
};

/** Starts a thread in a project for an ion's turn: its chat, or why it couldn't. */
type StartThread = (
  projectId: string,
  brief: string,
  turnId: string,
  picks?: ThreadPicks,
) => Promise<{ chatId: string } | { why: string }>;

export type IonDeps = Deps & {
  configFile: string;
  startThread?: StartThread;
  yourTools?: YourTools;
  /** One agent as ion knows it now (what you ask a chat to run on is checked against its sign-in). */
  agent?: (id: string) => Promise<HarnessInfo | undefined>;
};

const HISTORY_MAX = 200;
/** The most changes ion's dream makes in one night. */
const DREAM_CHANGES = 30;
/** ion chief and its dream see every project shared with ion; a project's ion only its own. */
const sharing = (ionId: string) => ionId === "chief" || ionId === DREAM_ION;
const TITLES = 5;

/** What an ion's tools share: its scope, the daemon, and the projects it may see right now. */
type Ion = {
  scope: IonScope;
  d: IonDeps;
  /** The key's projects that still exist, never `default`; ion chief's shared with it, a project's ion its own. */
  projects(): ProjectEntry[];
  /** The project, when this key may see it; else "Not allowed". */
  need(projectId: string): ProjectEntry;
};

function ionOf(scope: IonScope, d: IonDeps): Ion {
  const projects = () =>
    loadUserConfig(d.configFile).config.projects.filter(
      (p) =>
        scope.projects.includes(p.id) &&
        p.id !== DEFAULT_PROJECT &&
        // A project's ion sees its own project only, whatever its key lists; ion chief and its dream, those shared.
        (sharing(scope.ionId) ? p.shareWithIon !== false : p.id === scope.ionId),
    );
  const need = (projectId: string) => {
    const p = projects().find((x) => x.id === projectId);
    if (!p) throw new UserError("Not allowed");
    return p;
  };
  return { scope, d, projects, need };
}

/**
 * The tools an ion gets for one turn (ion chief, or a project's ion): only over the projects its key names.
 * Everything they return is labelled as data.
 */
export function registerIonTools(server: McpServer, scope: IonScope, d: IonDeps): void {
  const ion = ionOf(scope, d);
  if (scope.ionId === DREAM_ION) return dreamTools(server, ion);
  projectsTool(server, ion);
  chatTools(server, ion);
  needsTools(server, ion);
  memoryTools(server, ion);
  threadTool(server, ion);
  registerChatsTool(server, {
    scope,
    configFile: d.configFile,
    need: ion.need,
    ...(d.agent ? { agent: d.agent } : {}),
  });
  registerYourTools(server, {
    chief: scope.ionId === "chief",
    dirs: () => ion.projects().map((p) => p.path),
    ...(d.yourTools ? { yours: d.yourTools } : {}),
  });
  if (scope.ionId !== "chief") profileTool(server, ion);
}

/**
 * Your chats but those you said not to remember: an ion never reads those (review of #34, 2026-11-23: it could keep
 * what they said).
 */
const rememberedChats = (db: Db) => chatsView.list(db).filter((c) => !c.notRemembered);
const forgotten = (db: Db) =>
  chatsView
    .list(db)
    .filter((c) => c.notRemembered)
    .map((c) => c.chatId);

/** A project's chats, most recent first. */
const chatsOf = (chats: ChatInfo[], projectId: string) =>
  chats
    .filter((c) => c.projectId === projectId && !c.archived)
    .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));

function projectsTool(server: McpServer, ion: Ion): void {
  const { db } = ion.d;
  server.registerTool(
    "projects",
    {
      description:
        "The projects you look after: id, name, what each is, and what's happening there. With a query, the best matches first (at most 10).",
      inputSchema: { query: z.string().min(1).max(500).optional() },
    },
    guard(({ query }: { query?: string }) => {
      const chats = rememberedChats(db);
      // Most recently active first: the order ties keep when ranking.
      const latest = (id: string) => chatsOf(chats, id)[0]?.lastActivityAt ?? "";
      const list = ion.projects().sort((a, b) => latest(b.id).localeCompare(latest(a.id)));
      const status = contextOf(
        list.map((p) => p.id),
        chats,
        needsView.open(db),
      ).split("\n");
      const rows = list.map((p, i) => ({
        ...{ id: p.id, name: p.name, profile: profileOf(p), status: status[i]! },
        titles: chatsOf(chats, p.id)
          .slice(0, TITLES)
          .map((c) => c.title),
      }));
      const order = query ? rankProjects(query, rows) : rows.map((r) => r.id);
      const lines = order.map((id) => {
        const r = rows.find((x) => x.id === id)!;
        const name = r.name ? "name " + q(r.name) + ", " : "";
        return `${r.status}\n  ${name}profile ${q(r.profile)}`;
      });
      return ok(wrapData("projects", lines.join("\n")));
    }),
  );
}

/** The projects a lookup covers: the one asked for (if this key may see it), else all this key's. */
const idsOf = (ion: Ion, projectId?: string) =>
  projectId ? [ion.need(projectId).id] : ion.projects().map((p) => p.id);

function chatTools(server: McpServer, ion: Ion): void {
  const { db } = ion.d;
  server.registerTool(
    "search_chats",
    {
      description: "Search chats for words, in one project or all yours. At most 20 results.",
      inputSchema: { query: z.string().min(1).max(500), projectId: z.string().optional() },
    },
    guard(({ query, projectId }: { query: string; projectId?: string }) =>
      searchData(
        idsOf(ion, projectId)
          .flatMap((p) => messagesView.search(db, p, query, { limit: SEARCH_MAX, hidden: forgotten(db) }))
          .sort((a, b) => b.ts.localeCompare(a.ts))
          .slice(0, SEARCH_MAX),
      ),
    ),
  );
  server.registerTool(
    "chat_history",
    { description: "A chat's messages, oldest first.", inputSchema: { chatId: z.string().min(1) } },
    guard(({ chatId }: { chatId: string }) => {
      const chat = rememberedChats(db).find((c) => c.chatId === chatId);
      ion.need(chat?.projectId ?? "");
      return historyData(db, chatId, HISTORY_MAX);
    }),
  );
}

function needsTools(server: McpServer, ion: Ion): void {
  const { db } = ion.d;
  server.registerTool(
    "open_needs",
    {
      description: "What is waiting on the user, in one project or all yours.",
      inputSchema: { projectId: z.string().optional() },
    },
    guard(({ projectId }: { projectId?: string }) => {
      const mine = new Set(idsOf(ion, projectId));
      return needsData(needsView.open(db).filter((n) => mine.has(n.projectId ?? "")));
    }),
  );
  server.registerTool(
    "decisions",
    {
      description: "The user's past decisions in a project, and what happened after each.",
      inputSchema: { projectId: z.string().min(1) },
    },
    guard(({ projectId }: { projectId: string }) => {
      // An "everywhere" decision made in a project this key can't see stays hidden.
      const seen = new Set(idsOf(ion));
      const list = decisionsView.list(db, ion.need(projectId).id).filter((x) => seen.has(x.projectId));
      return ok(wrapData("your decisions", list.map((x) => decisionLine(x, projectId)).join("\n")));
    }),
  );
}

/** An ion whose memory is off gets no memory tools; one with some off, only what's on (the user, 2026-11-23). */
function memoryTools(server: McpServer, ion: Ion): void {
  const { scope, d } = ion;
  const caller = ionCaller(liveMemory(ion));
  if (!caller) return;
  const limit = {
    ...{ id: scope.turnId, max: PER_TURN, tooMany: "That's enough memory for one turn" },
    refuse: () => notInReport(scope),
  };
  registerMemoryTools(server, caller, d, limit);
}

/**
 * What an ion's memory is now: as at its turn's start, or as your switches say now, whichever is less (review of #34,
 * 2026-11-23: a switch took effect only at the next turn).
 */
function liveMemory(ion: Ion) {
  const { scope, d } = ion;
  const projects = ion.projects().map((p) => p.id);
  const own = scope.ionId !== "chief" && scope.ionId !== DREAM_ION;
  const now = ionMemory(loadUserConfig(d.configFile).config, projects, own);
  const memory = leastIonMemory(scope.memory, now);
  return { ...scope, projects, ...(memory ? { memory } : {}) };
}

/** ion's dream gets memory's tools only, for its pass, and what's left of its changes for the night. */
function dreamTools(server: McpServer, ion: Ion): void {
  const { scope, d } = ion;
  const { max, ...pass } = scope.dream ?? { see: "ions" as const, max: 0 };
  // Your files are context to its passes only while your memory is on (the user, 2026-11-23).
  const sees = ionCaller(liveMemory(ion));
  if (!sees) return;
  const caller = { ...sees, dream: pass };
  const tooMany = `That's ${DREAM_CHANGES} changes, the most for one night; stop here`;
  registerMemoryTools(server, caller, d, { id: scope.turnId, max, tooMany });
}

/** A report turn (its prompt holds a thread agent's words) writes nothing: no memory, no profile, no thread. */
function notInReport(scope: IonScope): void {
  if (scope.report) throw new UserError("Not in a report");
}

function threadTool(server: McpServer, ion: Ion): void {
  const { scope, d } = ion;
  server.registerTool(
    "start_thread",
    {
      description: `Start work in a project: a thread its agent runs, briefed with what to do there. To have it use a skill or a connection, name it in skills or mentions. Pass harness, model or effort only when the user asked for this chat to run on them (e.g. "use Codex for this, at low effort"); otherwise leave them out. At most ${PER_TURN} per turn.`,
      inputSchema: {
        projectId: z.string().min(1),
        brief: z.string().min(1).max(4000),
        skills: z.array(z.string().min(1).max(100)).max(10).optional(),
        mentions: z.array(z.string().min(1).max(100)).max(10).optional(),
        ...brainArgs(),
      },
    },
    guard(async (a: { projectId: string; brief: string } & ThreadPicks) => {
      const { projectId, brief } = a;
      const picks = picksOf(a);
      if (!d.startThread) throw new UserError("Not available here");
      notInReport(scope);
      ion.need(projectId);
      // A slot is taken before starting (two calls at once can't both take the 5th) and given back unless it started.
      if (d.grants.noteThread(scope.turnId) > PER_TURN) {
        d.grants.noteThread(scope.turnId, -1);
        throw new UserError("That's enough threads for one turn");
      }
      const r = await d.startThread(projectId, brief, scope.turnId, picks).catch((e: unknown) => {
        d.grants.noteThread(scope.turnId, -1);
        throw e;
      });
      if ("why" in r) {
        d.grants.noteThread(scope.turnId, -1);
        throw new UserError(r.why);
      }
      return ok(`Started ${r.chatId}`);
    }),
  );
}

/** The skills, mentions and asked-for agent, model and effort given, only the ones there are. */
const picksOf = (a: ThreadPicks): ThreadPicks => ({
  ...(a.skills?.length ? { skills: a.skills } : {}),
  ...(a.mentions?.length ? { mentions: a.mentions } : {}),
  ...(a.harness ? { harness: a.harness } : {}),
  ...(a.model ? { model: a.model } : {}),
  ...(a.effort ? { effort: a.effort } : {}),
});

function profileTool(server: McpServer, ion: Ion): void {
  const { scope, d } = ion;
  server.registerTool(
    "set_profile",
    {
      description:
        "Suggest what your project is, in a line or two. The user decides in Settings whether ion uses it.",
      inputSchema: { text: z.string().min(1).max(PROFILE_CHARS) },
    },
    guard(({ text }: { text: string }) => {
      notInReport(scope);
      // Security review, 2026-11-19: an agent's words never become the profile ion chief reads; only a suggestion.
      const profileSuggestion = cleanProfile(text);
      if (!profileSuggestion) throw new UserError("A profile can't be empty");
      const { config, error } = loadUserConfig(d.configFile);
      // A config ion can't read loads as the defaults: saving that would drop every project.
      if (error) throw new UserError("Can't read the config");
      const projectId = ion.need(scope.ionId).id;
      const projects = config.projects.map((p) => (p.id === projectId ? { ...p, profileSuggestion } : p));
      saveUserConfig(d.configFile, { ...config, projects });
      return ok("Saved as a suggestion; the user decides in Settings.");
    }),
  );
}
