import { randomBytes } from "node:crypto";
import { DEFAULT_PROJECT, loadUserConfig, type ProjectEntry } from "@ion/config";
import { type ChatInfo, EV, type SuggestionInfo, whenLabel } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { asksView, type ChiefCard, sameAs, suggestionsView } from "../views/suggestions.js";
import { habits, sameKey } from "./habits.js";

/** How often ion chief looks for something to suggest (and once at start). */
const LOOK_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A chat untouched this long, after a failed or stopped run, has stalled. */
const STALLED_MS = 3 * DAY_MS;
const STALLED_RUNS = new Set(["failed", "interrupted"]);

export type SuggestionsDeps = {
  store: EventStore;
  db: Db;
  configFile: string;
  /** How many files a chat changed in its worktree (0: none, or no worktree). */
  changes: (chatId: string) => Promise<number>;
  /** Adds a routine to a project's ion, the way you would. Throws why it can't. */
  addRoutine: (projectId: string, r: { name: string; when: string; text: string }) => void;
  /** Sends the chat its follow-up, on its own agent. */
  resume: (chatId: string) => Promise<void>;
};

const days = (since: string, now: number) => Math.floor((now - Date.parse(since)) / DAY_MS);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What a card asks, in a line (its message's words, and the CLI's). */
function askOf(c: ChiefCard): string {
  return c.kind === "routine" ? `Make “${c.name}” a routine?` : `Resume “${c.title}”?`;
}

/**
 * ion chief's own suggestions, in its chat: a routine for what you keep asking a project for, and a chat of yours
 * that stalled with work in it. It looks at start and then hourly; each suggestion is an event, so after a restart
 * it still knows what it offered and how you answered, and never offers the same one twice.
 */
export class Suggestions {
  private looking = false;
  /** Answers being carried out: a second click waits for nothing. */
  private readonly busy = new Set<string>();

  constructor(private readonly d: SuggestionsDeps) {}

  /** Looks now, then hourly. Returns stop. */
  start(): () => void {
    const timer = setInterval(() => void this.look(), LOOK_MS);
    void this.look();
    return () => clearInterval(timer);
  }

  async look(): Promise<void> {
    if (this.looking) return;
    this.looking = true;
    try {
      const now = new Date();
      const projects = this.projects();
      for (const p of projects.filter((x) => x.id !== DEFAULT_PROJECT)) this.routines(p, now);
      await this.stalled(new Set(projects.map((p) => p.id)), now.getTime());
    } finally {
      this.looking = false;
    }
  }

  /** Your open suggestions: not answered, and for a stalled chat, still stalled. */
  list(): SuggestionInfo[] {
    const now = Date.now();
    return suggestionsView
      .list(this.d.db)
      .filter((s) => s.answer === null && this.current(s.card))
      .map(({ card, at }) => ({
        suggestionId: card.suggestionId,
        kind: card.kind,
        projectId: card.projectId,
        title: askOf(card),
        detail:
          card.kind === "routine"
            ? `${whenLabel(card.when)} · asked on ${plural(card.dates.length, "day")}`
            : `Stalled ${plural(days(card.since, now), "day")} · ${plural(card.files, "file")}`,
        at,
      }));
  }

  owns(suggestionId: string): boolean {
    return suggestionsView.find(this.d.db, suggestionId) !== null;
  }

  /** Your answer: take it (add the routine, or resume the chat), or not now (mute: and no more like it there). */
  async answer(suggestionId: string, a: { keep: boolean; mute?: boolean }): Promise<void> {
    const s = suggestionsView.find(this.d.db, suggestionId);
    if (!s || s.answer !== null || this.busy.has(suggestionId))
      throw new UserError("That suggestion is gone");
    this.busy.add(suggestionId);
    try {
      if (a.keep) await this.take(s.card);
      const data = { suggestionId, keep: a.keep, ...(!a.keep && a.mute ? { mute: true as const } : {}) };
      this.d.store.append({
        chatId: "ion:chief",
        runId: null,
        origin: "daemon",
        type: EV.suggestionAnswered,
        data,
      });
    } finally {
      this.busy.delete(suggestionId);
    }
  }

  private async take(c: ChiefCard): Promise<void> {
    if (c.kind === "stalled") return this.d.resume(c.chatId);
    try {
      this.d.addRoutine(c.projectId, { name: c.name, when: c.when, text: c.text });
    } catch (e) {
      throw e instanceof UserError ? e : new UserError((e as Error).message);
    }
  }

  /** Projects ion chief may read: kept from it (shareWithIon = false), a project gives it nothing. */
  private projects(): ProjectEntry[] {
    return loadUserConfig(this.d.configFile).config.projects.filter((p) => p.shareWithIon !== false);
  }

  /** A stalled chat's card is current until the chat is touched again (or archived). */
  private current(c: ChiefCard): boolean {
    if (c.kind === "routine") return true;
    const chat = chatsView.list(this.d.db).find((x) => x.chatId === c.chatId);
    return !!chat && !chat.archived && chat.lastActivityAt === c.since;
  }

  /** Routines for what you keep asking this project for, unless one already does it or you muted them here. */
  private routines(p: ProjectEntry, now: Date): void {
    if (suggestionsView.muted(this.d.db, p.id, "routine")) return;
    const have = new Set((p.routines ?? []).flatMap((r) => [sameKey(r.name), sameKey(r.text)]));
    for (const h of habits(asksView.list(this.d.db, p.id), now)) {
      const card: ChiefCard = { kind: "routine", suggestionId: newId(), projectId: p.id, ...h };
      if (!have.has(h.key) && !suggestionsView.offered(this.d.db, sameAs(card))) this.say(card);
    }
  }

  /** Your chats whose last run failed or was stopped, untouched for 3 days, with changes in their worktree. */
  private async stalled(shared: Set<string>, now: number): Promise<void> {
    const stale = (c: ChatInfo) =>
      c.by !== "ion" &&
      !c.archived &&
      shared.has(c.projectId ?? "") &&
      STALLED_RUNS.has(c.lastRunStatus ?? "") &&
      !!c.lastActivityAt &&
      now - Date.parse(c.lastActivityAt) >= STALLED_MS &&
      !suggestionsView.muted(this.d.db, c.projectId ?? "", "stalled");
    for (const c of chatsView.list(this.d.db).filter(stale)) {
      const card: ChiefCard = {
        ...{ kind: "stalled", suggestionId: newId(), chatId: c.chatId, projectId: c.projectId ?? "" },
        ...{ title: c.title, since: c.lastActivityAt!, files: 0 },
      };
      if (suggestionsView.offered(this.d.db, sameAs(card))) continue;
      const files = await this.d.changes(c.chatId).catch(() => 0);
      if (files > 0) this.say({ ...card, files });
    }
  }

  private say(card: ChiefCard): void {
    this.d.store.append({
      chatId: "ion:chief",
      runId: null,
      origin: "daemon",
      type: EV.ionSaid,
      data: { text: askOf(card), card },
    });
  }
}

const newId = () => `s${randomBytes(4).toString("hex")}`;
