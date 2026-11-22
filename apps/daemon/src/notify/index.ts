import {
  DEFAULT_CONFIG,
  DEFAULT_PROJECT,
  loadUserConfig,
  type ProjectEntry,
  type UserConfig,
} from "@ion/config";
import { EV, type IonEvent, type NeedInfo, type NotifyKind } from "@ion/schema";
import type { MemoryFiles } from "../memory/index.js";
import { REMIND_AT, remindIfDue } from "../scheduler/reminders.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { needsView } from "../views/needs.js";
import type { MemoryRow } from "../views/memory.js";
import { briefIfDue, dueTodayLine, line } from "./briefing.js";
import { dayOf, lastQuiet, nextAt, quietNow, type Window } from "./clock.js";

/** The stream the app listens on for system notifications. */
const STREAM = "notify";
/** ion chief's thread: a to-do's reminder opens it. */
const CHIEF = "ion:chief";
/** The timer looks again at least this often, so a setting you changed (or a computer that slept) is noticed. */
const LOOK_MS = 5 * 60_000;
/**
 * The summary goes when quiet hours end, or soon after (a tick late); a window that ended longer ago has none, unless
 * ion was running since before it ended (the computer slept through its end).
 */
const SLACK_MS = LOOK_MS + 60_000;
/** What can be worth a notification: a need raised, a run's end. */
const SOURCES = [EV.needRaised, EV.runFinished];
/** Errors that mean ion itself ended the run (stopped, or restarted after a crash): it didn't give up. */
const ION_ENDED = new Set(["daemon_restarted", "daemon_stopped"]);

type Level = NonNullable<ProjectEntry["notify"]>;
type Item = { kind: Exclude<NotifyKind, "summary">; projectId: string | null; body: string; chatId: string };
type Notice = { title: string; body: string; chatId?: string; kind: NotifyKind };
type Log = { store: EventStore; db: Db };

/** What each project level lets notify you (Muted: nothing; it's still pinned and in the briefing). */
const LOUD: Record<Level, ReadonlySet<NotifyKind>> = {
  all: new Set(["urgent", "needs", "update"]),
  needs: new Set(["urgent", "needs"]),
  digest: new Set(["urgent"]),
  muted: new Set(),
};

const chatOf = (db: Db, chatId: string) => chatsView.list(db).find((c) => c.chatId === chatId);

/**
 * How loud an event is, or null when it's not news: a call ion stopped (blocked) or a run that gave up is Urgent,
 * any other question is Needs you, a run that finished is an Update. ion's own chats and questions held behind
 * another aren't.
 */
function itemOf(d: Log, e: IonEvent): Item | null {
  if (!e.chatId || e.chatId.startsWith("ion:")) return null;
  const chat = chatOf(d.db, e.chatId);
  const base = { projectId: chat?.projectId ?? null, chatId: e.chatId };
  if (e.type === EV.needRaised) {
    const d = e.data as { summary: string; blocked?: boolean; heldFor?: string };
    if (d.heldFor) return null;
    return { ...base, kind: d.blocked ? "urgent" : "needs", body: line(d.summary) || "A question for you" };
  }
  if (!chat || e.type !== EV.runFinished || endedByIon(d.store, e.runId)) return null;
  return runEnd(base, chat.title, (e.data as { status: string }).status);
}

/** Whether ion's own stop or restart ended the run (its error says so). */
const endedByIon = (store: EventStore, runId: string | null) =>
  !!runId &&
  store
    .read({ runId, types: [EV.error] })
    .some((e) => ION_ENDED.has(String((e.data as { code?: unknown }).code)));

/** A run that finished is an Update, one that gave up (failed after its retries) Urgent; one you stopped isn't. */
function runEnd(base: Omit<Item, "kind" | "body">, title: string, status: string): Item | null {
  if (status === "done") return { ...base, kind: "update", body: line(`Finished: ${title}`) };
  if (status === "failed") return { ...base, kind: "urgent", body: line(`Failed: ${title}`) };
  return null;
}

/**
 * The settings used while your config doesn't load and none loaded before: only Urgent notifies (every project
 * counts as Digest), no briefing.
 */
const URGENT_ONLY: UserConfig = {
  ...DEFAULT_CONFIG,
  projects: [],
  notifications: { ...DEFAULT_CONFIG.notifications, briefing: { on: false, at: "08:30" } },
};

/** A project's entry, `default` (your chats outside a project) too; none for a project since removed. */
const entryOf = (c: UserConfig, projectId: string | null) =>
  projectId ? c.projects.find((p) => p.id === projectId) : undefined;

/** Whether the project's level lets it notify you (no entry, or one since removed: "needs"). */
const allowed = (c: UserConfig, i: Item) =>
  LOUD[entryOf(c, i.projectId)?.notify ?? (c === URGENT_ONLY ? "digest" : "needs")].has(i.kind);

/** A notification's title: its project's name, or ion (your chats outside a project too). */
const titleOf = (c: UserConfig, projectId: string | null) => {
  const p = projectId === DEFAULT_PROJECT ? undefined : entryOf(c, projectId);
  return p ? line(p.name ?? p.id) : "ion";
};

const things = (n: number) => (n === 1 ? "1 thing needs you" : `${n} things need you`);

/** An open need as a notification item (an ion chat's or one held behind another: none). */
const needItem = (n: NeedInfo): Item | null =>
  n.chatId.startsWith("ion:")
    ? null
    : { kind: n.blocked ? "urgent" : "needs", projectId: n.projectId, chatId: n.chatId, body: n.summary };

/**
 * What quiet hours held, counted when they end: needs still open and runs that gave up, raised in the window after
 * the last notification that went out in it (before then quiet hours were off), that the project's level lets
 * notify you. A need you answered meanwhile, or a finished run, isn't counted.
 */
function heldIn(d: Log, c: UserConfig, w: { from: string; end: string }): number {
  const inWindow = (ts: string) => ts > w.from && ts < w.end;
  const needs = needsView
    .open(d.db)
    .filter((n) => inWindow(n.raisedAt))
    .map(needItem);
  const gaveUp = d.store
    .read({ since: w.from, types: [EV.runFinished] })
    .filter((e) => inWindow(e.ts))
    .map((e) => itemOf(d, e))
    .filter((i) => i?.kind === "urgent");
  return [...needs, ...gaveUp].filter((i) => i !== null && allowed(c, i)).length;
}

/**
 * Turns what happens into system notifications by how loud it is and the project's level, holds them through quiet
 * hours (what's held is the events themselves, so a restart keeps it) and sends one summary when they end; and at
 * the briefing's time, ion chief's daily briefing. One timer, set for the next moment something is due.
 */
export class Notifier {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private off: (() => void) | undefined;
  /** The day the briefing is settled (posted, or nothing to say): ticks don't look again that day. */
  private looked: string | null = null;
  /** The end of the last quiet window whose summary is settled (sent, or nothing held): ticks don't look again. */
  private summarized: string | null = null;
  /** When this notifier started: a window that ended after it may be summed up late (the computer slept). */
  private started = 0;
  /** The settings last read without an error: kept while a hand edit leaves the file unreadable. */
  private good: UserConfig | null = null;

  /** The day to-dos due today are settled (reminded, or none): ticks don't look again that day. */
  private reminded: string | null = null;

  constructor(private readonly d: { store: EventStore; db: Db; configFile: string; memory?: MemoryFiles }) {}

  start(): void {
    this.started = Date.now();
    this.off = this.d.store.onAppend((e) => this.heard(e));
    this.tick();
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Settings are read each time: they change at any time. A file that doesn't load: the last good ones. */
  private config(): UserConfig {
    const { config, error } = loadUserConfig(this.d.configFile);
    if (!error) this.good = config;
    return this.good ?? URGENT_ONLY;
  }

  private heard(e: IonEvent): void {
    if (!SOURCES.includes(e.type as (typeof SOURCES)[number])) return;
    try {
      const item = itemOf(this.d, e);
      const c = this.config();
      // Held through quiet hours: the event itself is what's kept; the summary counts it when they end.
      if (!item || !allowed(c, item) || quietNow(c.notifications.quiet, new Date())) return;
      this.send({ title: titleOf(c, item.projectId), body: item.body, chatId: item.chatId, kind: item.kind });
    } catch (err) {
      // A notification that couldn't be made never stops what raised it.
      console.warn(`ion couldn't notify: ${(err as Error).message}`);
    }
  }

  private send(data: Notice): void {
    this.d.store.append({ chatId: STREAM, runId: null, origin: "daemon", type: EV.notify, data });
  }

  private tick(): void {
    const now = new Date();
    const c = this.config();
    try {
      this.summarize(c, now);
      const day = dayOf(now);
      if (this.looked !== day && briefIfDue(this.d, c, now) !== "waiting") this.looked = day;
      this.remindTodos(c, now, day);
    } catch (err) {
      console.warn(`ion couldn't notify: ${(err as Error).message}`);
    }
    this.arm(c, now);
  }

  /** To-dos due today: their line in ion chief's thread, and a "needs you" notification by each project's level. */
  private remindTodos(c: UserConfig, now: Date, day: string): void {
    const memory = this.d.memory;
    if (!memory || this.reminded === day) return;
    const due = remindIfDue({ store: this.d.store, memory }, c, now);
    if (due === "waiting") return;
    this.reminded = day;
    const byProject = new Map<string | null, MemoryRow[]>();
    for (const t of due) {
      const projectId = t.scope === "you" ? null : t.scope.projectId;
      byProject.set(projectId, [...(byProject.get(projectId) ?? []), t]);
    }
    for (const [projectId, todos] of byProject) {
      const item: Item = { kind: "needs", projectId, chatId: CHIEF, body: dueTodayLine(todos) };
      if (allowed(c, item))
        this.send({ title: titleOf(c, projectId), body: item.body, chatId: CHIEF, kind: "needs" });
    }
  }

  /** The next moment something is due: quiet hours' end, the briefing, reminders, or a look in a few minutes. */
  private arm(c: UserConfig, now: Date): void {
    const due = [c.notifications.quiet.to, c.notifications.briefing.at, REMIND_AT].map(
      (clock) => nextAt(clock, now).getTime() - now.getTime(),
    );
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), Math.min(LOOK_MS, ...due));
    this.timer.unref?.();
  }

  /**
   * Once the last quiet hours ended (a tick ago at most, or while ion ran; not during the next ones): one summary of what they held,
   * unless it went already. Settled once per window, so later ticks read nothing.
   */
  private summarize(c: UserConfig, now: Date): void {
    const q = c.notifications.quiet;
    const w = lastQuiet(q, now);
    if (!w || quietNow(q, now) || this.summarized === w.end.toISOString()) return;
    this.summarized = w.end.toISOString();
    if (now.getTime() - w.end.getTime() > SLACK_MS && this.started > w.end.getTime()) return;
    const from = this.heldFrom(w);
    if (from === null) return;
    const held = heldIn(this.d, c, { from, end: w.end.toISOString() });
    if (held > 0) this.send({ title: "ion", body: things(held), kind: "summary" });
  }

  /**
   * Where what the window held starts: its start, or the last notification that went out in it (quiet hours were
   * off until then); null when its summary already went.
   */
  private heldFrom(w: Window): string | null {
    const end = w.end.toISOString();
    const sent = this.d.store.read({ chatId: STREAM, since: w.start.toISOString(), types: [EV.notify] });
    if (sent.some((e) => e.ts >= end && (e.data as Notice).kind === "summary")) return null;
    const live = sent.filter((e) => e.ts < end && (e.data as Notice).kind !== "summary").at(-1);
    // Just before the start, so a need raised at the very start counts (the window is from < ts < end).
    return live?.ts ?? new Date(w.start.getTime() - 1).toISOString();
  }
}
