import { DEFAULT_PROJECT, loadUserConfig, type UserConfig } from "@ion/config";
import { type DreamInfo, EV, type IonEvent, type MemoryBy, type MemoryScope } from "@ion/schema";
import { UserError } from "../api/errors.js";
import { wrapData } from "../context/index.js";
import { dayOf, onDay, quietNow } from "../notify/clock.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { messagesView } from "../views/messages.js";
import { DREAM_ION, type DreamPass } from "./dream-rules.js";
import type { MemoryFile, MemoryFiles } from "./index.js";
import { lineOf, ScopedMemory } from "./scoped.js";
import { sharedIds } from "./todos.js";

/** How a dream's turn ended: its reply, and whether it ran out of time or couldn't reach its agent. */
export type DreamTurn = { reply: string; status: "done" | "failed" | "late" };

/** One pass of a dream: which files it sees and changes, how many changes are left, and how long it has. */
type DreamStep = { pass: DreamPass; max: number; ms: number };

export type DreamDeps = {
  store: EventStore;
  db: Db;
  memory: MemoryFiles;
  configFile: string;
  /** One pass of ion's dream with this prompt (ion's turn, with memory's tools only). */
  think: (prompt: string, step: DreamStep) => Promise<DreamTurn>;
};

/** What a `memory.dreamed` event holds. */
type Dreamed = Omit<DreamInfo, "at" | "forgotten"> & {
  forgotten: string[];
  changed: string[];
  status: DreamTurn["status"] | "started";
  period?: string;
};

/** A dream starts at 3:00 local (until 6:00), or in quiet hours when that night's was missed. */
const DREAM_AT = "03:00";
const DREAM_UNTIL = "06:00";
const DAY_MS = 86_400_000;
/** What the dream reads of recent chats: the last week's, the latest first, each message cut short. */
const CHATS_DAYS = 7;
const CHATS_MAX = 20;
const SAID_MAX = 400;
const NOTES_MAX = 2;
const NOTE_CHARS = 300;
/** A night's limits, over all its passes. */
const DREAM_CHANGES = 30;
const DREAM_MS = 600_000;
const ALL = Number.MAX_SAFE_INTEGER;

const NO_CHAT = { chatId: null, runId: null, origin: "daemon" as const };
const NOTHING = { merged: 0, updated: 0, forgot: 0, moved: 0, forgotten: [], changed: [], notes: [] };
const clean = (t: string) => t.replace(/[^\P{Cc}\n\t]/gu, "");
const oneLine = (t: string, max: number) => {
  const s = clean(t).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};
const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const byDream = (by: MemoryBy) => by !== "you" && "ion" in by && by.ion === DREAM_ION;

/** The nights already dreamed for (or being dreamed now), each by its local date. */
export const servedPeriods = (store: EventStore): Set<string> =>
  new Set(
    store
      .read({ types: [EV.memoryDreamed] })
      .map((e) => (e.data as { period?: string }).period)
      .filter((p): p is string => !!p),
  );

/** The night `now` belongs to: the last 3:00 that has come (weekly: the last Monday's). */
function periodOf(c: UserConfig, now: Date): Date {
  const today = onDay(now, DREAM_AT);
  const night = now >= today ? today : onDay(now, DREAM_AT, -1);
  if (c.memory.dream !== "weekly") return night;
  return onDay(night, DREAM_AT, -((night.getDay() + 6) % 7));
}

/**
 * The night to dream for now, or null: it's on, that night (its 3:00) hasn't been dreamed for, and it's 3:00 to 6:00
 * or quiet hours. A night missed (asleep, ion not running) is caught up once, the next time ion is up in quiet hours,
 * else it waits for the next 3:00; never in the working day.
 */
export function dreamDue(c: UserConfig, now: Date, served: ReadonlySet<string>): string | null {
  if (c.memory.dream === "off") return null;
  // The night's local date: a change of time zone doesn't make it another night (task review, 2026-11-22).
  const key = dayOf(periodOf(c, now));
  if (served.has(key)) return null;
  const early = now >= onDay(now, DREAM_AT) && now < onDay(now, DREAM_UNTIL);
  return early || quietNow(c.notifications.quiet, now) ? key : null;
}

/** The latest chats of the last week (in projects shared with ion): your last message and the agent's last reply. */
function recentChats(db: Db, c: UserConfig, now: Date, pass: DreamPass): string {
  // A project's passes read only its chats; yours read none (every project's ion reads your files).
  if (!pass.project || !sharedIds(c).includes(pass.project)) return "";
  const since = new Date(now.getTime() - CHATS_DAYS * DAY_MS).toISOString();
  const chats = chatsView
    .list(db)
    .filter((x) => !x.archived && (x.lastActivityAt ?? "") >= since && x.projectId === pass.project)
    .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))
    .slice(0, CHATS_MAX);
  const lines = chats.flatMap((x) => {
    const you = messagesView.last(db, x.chatId, "you");
    const agent = messagesView.last(db, x.chatId, "agent");
    if (!you && !agent) return [];
    const where = x.projectId && x.projectId !== DEFAULT_PROJECT ? ` (${x.projectId})` : "";
    const at = dayOf(new Date(x.lastActivityAt ?? now));
    return [
      `${oneLine(x.title, 80)}${where}, ${at}:`,
      ...(you ? [`  you: ${oneLine(you, SAID_MAX)}`] : []),
      ...(agent ? [`  agent: ${oneLine(agent, SAID_MAX)}`] : []),
    ];
  });
  return lines.join("\n");
}

/** What a pass changes, in a line for its prompt. */
function passLine(pass: DreamPass): string {
  const whose = pass.project ? `the project ${pass.project}'s` : "the user's own";
  const kind = pass.see === "ions" ? "that chats can't see (see: ions)" : "that chats see";
  return `This pass changes only ${whose} files ${kind}; the others are context.`;
}

/** The dream ion as one pass of it sees memory. */
const passMemory = (d: Pick<DreamDeps, "memory">, c: UserConfig, pass: DreamPass) =>
  new ScopedMemory(d.memory, { kind: "ion", ionId: DREAM_ION, projects: sharedIds(c), dream: pass });

/** A pass's message: today's date, the files it may see, and the chats it may read, both as data. */
function dreamPrompt(d: Pick<DreamDeps, "db" | "memory">, c: UserConfig, now: Date, pass: DreamPass): string {
  const index = passMemory(d, c, pass).index().map(lineOf).join("\n");
  const chats = recentChats(d.db, c, now, pass);
  return [
    `Today is ${dayOf(now)}. Tidy ion's memory now, as your instructions say, then reply with what you did.`,
    passLine(pass),
    index ? wrapData("ion's memory index", index) : "Memory is empty: there's nothing to tidy.",
    chats ? wrapData("recent chats (last 7 days)", chats) : "No chats for this pass.",
  ].join("\n\n");
}

/** Up to two lines the dream left for you ("Note: …"). */
function notesOf(reply: string): string[] {
  return reply
    .split("\n")
    .map((l) => l.trim().replace(/^[-*] /, ""))
    .filter((l) => /^(note:|dream skipped:)/i.test(l))
    .map((l) => (/^note:/i.test(l) ? l.slice(5).trim() : l))
    .filter(Boolean)
    .slice(0, NOTES_MAX)
    .map((n) => oneLine(n, NOTE_CHARS));
}

/** What the dream's changes since `since` were: merges and moves (a file forgotten `into` another), updates, forgets. */
function summarize(store: EventStore, since: string, turn: DreamTurn): Dreamed {
  const events = store
    .read({ since, types: [EV.memoryWritten, EV.memoryForgotten] })
    .filter((e) => byDream((e.data as { by: MemoryBy }).by));
  const s: Dreamed = {
    merged: 0,
    updated: 0,
    forgot: 0,
    moved: 0,
    forgotten: [],
    changed: [],
    notes: [],
    status: turn.status,
  };
  const targets = new Set<string>();
  for (const e of events.filter((x) => x.type === EV.memoryForgotten)) {
    const { path, into } = e.data as { path: string; into?: string };
    s.forgotten.push(path);
    if (!into) s.forgot++;
    else {
      targets.add(into);
      if (folderOf(into) === folderOf(path)) s.merged++;
      else s.moved++;
    }
  }
  const written = new Set(
    events.filter((x) => x.type === EV.memoryWritten).map((x) => (x.data as { path: string }).path),
  );
  s.changed = [...written].filter((p) => !s.forgotten.includes(p));
  s.updated = s.changed.filter((p) => !targets.has(p)).length;
  return {
    ...s,
    notes: notesOf(turn.reply),
    forgotten: s.forgotten.slice(0, 100),
    changed: s.changed.slice(0, 100),
  };
}

/** The file's name as it was last written (a forgotten file's too). */
function nameOf(memory: MemoryFiles, path: string): string {
  return memory.history(path).findLast((c) => c.header)?.header?.name ?? path;
}

/** A dream as Settings and the briefing say it; its forgotten files only while they're still gone. */
function infoOf(memory: MemoryFiles, e: IonEvent): DreamInfo {
  const d = e.data as Dreamed;
  const gone = d.forgotten.filter((p) => !memory.row(p));
  return {
    ...{ at: e.ts, merged: d.merged, updated: d.updated, forgot: d.forgot, moved: d.moved, notes: d.notes },
    forgotten: gone.map((path) => ({ path, name: nameOf(memory, path) })),
  };
}

/**
 * ion dreams once: one turn of the dream ion with memory's tools only (the turn's own limits: 30 changes, about 10
 * minutes), then what it did is recorded (`memory.dreamed`), for the briefing and Settings.
 */
export async function runDream(d: DreamDeps, period?: string): Promise<DreamInfo> {
  const c = loadUserConfig(d.configFile).config;
  const now = new Date();
  const since = now.toISOString();
  const at = { ...(period ? { period } : {}) };
  // Recorded first: a restart mid-dream never dreams that night again.
  d.store.append({ ...NO_CHAT, type: EV.memoryDreamed, data: { ...NOTHING, status: "started", ...at } });
  const turn = await passes(d, c, since);
  const data = { ...summarize(d.store, since, turn), ...at };
  return infoOf(d.memory, d.store.append({ ...NO_CHAT, type: EV.memoryDreamed, data }));
}

/**
 * The night's passes (task review, 2026-11-22: ions-only text never reaches a file chats see, and no pass mixes two
 * projects): per project, its chats files then its ions files; then yours, likewise, with no chats; all within 30
 * changes and 10 minutes.
 */
async function passes(d: DreamDeps, c: UserConfig, since: string): Promise<DreamTurn> {
  const start = Date.now();
  const turns: DreamTurn[] = [];
  for (const pass of passesOf(d, c)) {
    const step = {
      pass,
      max: DREAM_CHANGES - changesSince(d.store, since),
      ms: DREAM_MS - (Date.now() - start),
    };
    if (step.max <= 0 || step.ms <= 0) break;
    const turn = await d.think(dreamPrompt(d, c, new Date(), pass), step);
    turns.push(turn);
    if (turn.status === "failed") break;
  }
  const worst = turns.find((t) => t.status === "failed") ?? turns.find((t) => t.status === "late");
  return { reply: turns.map((t) => t.reply).join("\n"), status: worst?.status ?? "done" };
}

/** Which passes a night has: only those with files to tidy. */
function passesOf(d: DreamDeps, c: UserConfig): DreamPass[] {
  const ion = { kind: "ion" as const, ionId: DREAM_ION, projects: sharedIds(c) };
  // Suggestions aren't the dream's: they never make a pass (final review, 2026-11-22).
  const all = new ScopedMemory(d.memory, ion).index({ limit: ALL }).filter((r) => !r.suggested);
  const have = new Set(all.map((r) => `${r.scope === "you" ? "" : r.scope.projectId}\n${r.see}`));
  const projects = [...new Set(all.flatMap((r) => (r.scope === "you" ? [] : [r.scope.projectId])))].sort();
  return [...projects, null].flatMap((project) =>
    (["chats", "ions"] as const)
      .filter((see) => have.has(`${project ?? ""}\n${see}`))
      .map((see) => ({ see, project })),
  );
}

/** How many changes the dream made since `since`. */
const changesSince = (store: EventStore, since: string) =>
  store
    .read({ since, types: [EV.memoryWritten, EV.memoryForgotten] })
    .filter((e) => byDream((e.data as { by: MemoryBy }).by)).length;

/**
 * A dream that started and never ended (ion stopped mid-dream) is summed up at the next start: what it changed,
 * as failed, for its night (task review, 2026-11-22).
 */
export function closeCutOff(store: EventStore): void {
  const last = store.read({ types: [EV.memoryDreamed] }).at(-1);
  const d = last?.data as Dreamed | undefined;
  if (!last || d?.status !== "started") return;
  const data = {
    ...summarize(store, last.ts, { reply: "", status: "failed" }),
    ...(d.period ? { period: d.period } : {}),
  };
  store.append({ ...NO_CHAT, type: EV.memoryDreamed, data });
}

/** What the last dream did, within a day of it, when it changed something or left a note (else null). */
export function tidied(store: EventStore, memory: MemoryFiles, now = new Date()): DreamInfo | null {
  const e = store
    .read({ types: [EV.memoryDreamed] })
    .findLast((x) => (x.data as Dreamed).status !== "started");
  if (!e || e.ts < new Date(now.getTime() - DAY_MS).toISOString()) return null;
  const info = infoOf(memory, e);
  const any = info.merged + info.updated + info.forgot + info.moved > 0 || info.notes.length > 0;
  return any ? info : null;
}

/**
 * The briefing's lines for the dreams since `since`: "Tidied memory: merged 2, updated 1, forgot 1 — undo in Memory."
 * and the last one's notes; none when they changed nothing and said nothing.
 */
export function dreamLines(store: EventStore, since: string): string[] {
  const all = store
    .read({ since, types: [EV.memoryDreamed] })
    .map((e) => e.data as Dreamed)
    .filter((x) => x.status !== "started");
  if (!all.length) return [];
  const sum = (k: "merged" | "updated" | "forgot" | "moved") => all.reduce((n, x) => n + x[k], 0);
  const parts = (["merged", "updated", "forgot", "moved"] as const)
    .filter((k) => sum(k) > 0)
    .map((k) => `${k} ${sum(k)}`);
  const tidiedLine = parts.length ? [`Tidied memory: ${parts.join(", ")} — undo in Memory.`] : [];
  return [...tidiedLine, ...all.at(-1)!.notes];
}

/** The scope and slug a memory path names. */
function partsOf(path: string): { scope: MemoryScope; slug: string } {
  const bits = path.slice(0, -3).split("/");
  return { scope: bits[0] === "you" ? "you" : { projectId: bits[1]! }, slug: bits.at(-1)! };
}

/** Brings back a forgotten file as it was last (its header and text), by you; refused while a file is there. */
export function restoreForgotten(memory: MemoryFiles, path: string): MemoryFile {
  const now = memory.read(path);
  if (now.ok || !now.gone) throw new UserError("It's there already");
  const changes = memory.history(path);
  const last = changes.at(-1);
  const header = changes.findLast((c) => c.header)?.header;
  if (last?.kind !== "forgotten" || !last.before || !header) throw new UserError("Nothing to restore");
  return memory.write({ ...partsOf(path), header, text: last.before.text, by: "you" });
}
