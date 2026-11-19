import { DEFAULT_PROJECT, loadUserConfig, type ProjectEntry, type UserConfig } from "@ion/config";
import { EV, type IonEvent, type NotifyKind } from "@ion/schema";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { briefIfDue, line } from "./briefing.js";
import { dayOf, lastQuiet, nextAt, quietNow } from "./clock.js";

/** The stream the app listens on for system notifications. */
const STREAM = "notify";
/** The timer looks again at least this often, so a setting you changed (or a computer that slept) is noticed. */
const LOOK_MS = 5 * 60_000;
/** What can be worth a notification: a need raised, a run's end. */
const SOURCES = [EV.needRaised, EV.runFinished];

type Level = NonNullable<ProjectEntry["notify"]>;
type Item = { kind: Exclude<NotifyKind, "summary">; projectId: string | null; body: string; chatId: string };
type Notice = { title: string; body: string; chatId?: string; kind: NotifyKind };

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
function itemOf(db: Db, e: IonEvent): Item | null {
  if (!e.chatId || e.chatId.startsWith("ion:")) return null;
  const chat = chatOf(db, e.chatId);
  const base = { projectId: chat?.projectId ?? null, chatId: e.chatId };
  if (e.type === EV.needRaised) {
    const d = e.data as { summary: string; blocked?: boolean; heldFor?: string };
    if (d.heldFor) return null;
    return { ...base, kind: d.blocked ? "urgent" : "needs", body: line(d.summary) || "A question for you" };
  }
  return chat && e.type === EV.runFinished
    ? runEnd(base, chat.title, (e.data as { status: string }).status)
    : null;
}

/** A run that finished is an Update, one that gave up (failed after its retries) Urgent; one you stopped isn't. */
function runEnd(base: Omit<Item, "kind" | "body">, title: string, status: string): Item | null {
  if (status === "done") return { ...base, kind: "update", body: line(`Finished: ${title}`) };
  if (status === "failed") return { ...base, kind: "urgent", body: line(`Failed: ${title}`) };
  return null;
}

/** A project's own entry; none for your chats outside a project (or a project since removed). */
const projectOf = (c: UserConfig, projectId: string | null) =>
  projectId && projectId !== DEFAULT_PROJECT ? c.projects.find((p) => p.id === projectId) : undefined;

/** Whether the project's level lets it notify you (no project, or one since removed: "needs"). */
const allowed = (c: UserConfig, i: Item) => LOUD[projectOf(c, i.projectId)?.notify ?? "needs"].has(i.kind);

/** A notification's title: its project's name, or ion. */
const titleOf = (c: UserConfig, projectId: string | null) => {
  const p = projectOf(c, projectId);
  return p ? (p.name ?? p.id) : "ion";
};

const things = (n: number) => (n === 1 ? "1 thing needs you" : `${n} things need you`);

/**
 * Turns what happens into system notifications by how loud it is and the project's level, holds them through quiet
 * hours (what's held is the events themselves, so a restart keeps it) and sends one summary when they end; and at
 * the briefing's time, ion chief's daily briefing. One timer, set for the next moment something is due.
 */
export class Notifier {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private off: (() => void) | undefined;
  /** The day the briefing was looked at and had nothing to say. */
  private looked: string | null = null;

  constructor(private readonly d: { store: EventStore; db: Db; configFile: string }) {}

  start(): void {
    this.off = this.d.store.onAppend((e) => this.heard(e));
    this.tick();
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Settings are read each time: they change at any time. */
  private config(): UserConfig {
    return loadUserConfig(this.d.configFile).config;
  }

  private heard(e: IonEvent): void {
    if (!SOURCES.includes(e.type as (typeof SOURCES)[number])) return;
    try {
      const item = itemOf(this.d.db, e);
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
      if (this.looked !== day && briefIfDue(this.d, c, now) === "nothing") this.looked = day;
    } catch (err) {
      console.warn(`ion couldn't notify: ${(err as Error).message}`);
    }
    this.arm(c, now);
  }

  /** The next moment something is due: quiet hours' end, the briefing, or a look in a few minutes. */
  private arm(c: UserConfig, now: Date): void {
    const due = [c.notifications.quiet.to, c.notifications.briefing.at].map(
      (clock) => nextAt(clock, now).getTime() - now.getTime(),
    );
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), Math.min(LOOK_MS, ...due));
    this.timer.unref?.();
  }

  /** Once the last quiet hours ended: one summary of what they held, unless it went already. */
  private summarize(c: UserConfig, now: Date): void {
    const w = lastQuiet(c.notifications.quiet, now);
    if (!w) return;
    const end = w.end.toISOString();
    const sent = this.d.store
      .read({ chatId: STREAM, since: end, types: [EV.notify] })
      .some((e) => (e.data as Notice).kind === "summary");
    if (sent) return;
    const held = this.d.store
      .read({ since: w.start.toISOString(), types: SOURCES })
      .filter((e) => e.ts < end)
      .map((e) => itemOf(this.d.db, e))
      .filter((i) => i !== null && allowed(c, i)).length;
    if (held > 0) this.send({ title: "ion", body: things(held), kind: "summary" });
  }
}
