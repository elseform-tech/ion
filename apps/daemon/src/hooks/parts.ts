import type { HookEntry, UserConfig } from "@ion/config";
import { EV, type HookEvent, type IonEvent } from "@ion/schema";
import type { Sign } from "../secrets/consent-key.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { consentOf, hookHasher, usableHooks } from "./consent.js";

/** Errors that mean ion itself ended the run (stopped, or restarted after a crash): the chat didn't fail. */
const ION_ENDED = new Set(["daemon_restarted", "daemon_stopped"]);

/** Whether ion's own stop or restart ended the run (its error says so). */
export const endedByIon = (store: EventStore, runId: string | null): boolean =>
  !!runId &&
  store
    .read({ runId, types: [EV.error] })
    .some((e) => ION_ENDED.has(String((e.data as { code?: unknown }).code)));

/** The event's project: a routine's own, else its chat's. */
export function projectOf(db: Db, e: IonEvent): string | null {
  const own = (e.data as { projectId?: unknown }).projectId;
  if (typeof own === "string") return own;
  if (!e.chatId) return null;
  return chatsView.list(db).find((c) => c.chatId === e.chatId)?.projectId ?? null;
}

/**
 * The hooks that run on this event, in order: on, turned on in the app for exactly what they run now (a record
 * signed with ion's key), for its project or all projects. `unverified`: one has a record ion couldn't check (the
 * keychain can't be read), so it didn't run.
 */
export async function activeHooks(
  c: UserConfig,
  sign: Sign,
  at: { event: HookEvent; projectId: string | null },
): Promise<{ list: HookEntry[]; unverified: boolean }> {
  const here = usableHooks(c.tools.hooks).filter(
    (h) => h.event === at.event && (!h.project || h.project === at.projectId),
  );
  if (!here.length) return { list: [], unverified: false };
  const hash = await hookHasher(sign, here);
  const states = here.map((h) => ({ h, s: consentOf(h, c.tools.hooksOn, hash) }));
  return {
    list: states.filter((x) => x.s.on).map((x) => x.h),
    unverified: states.some((x) => x.s.unverified),
  };
}

/** At most `n` at once for each key (a run's hook processes); the others wait their turn. */
export class Slots {
  private readonly busy = new Map<string, { n: number; waiting: (() => void)[] }>();

  constructor(private readonly max: number) {}

  async take(key: string): Promise<() => void> {
    const s = this.busy.get(key) ?? { n: 0, waiting: [] };
    this.busy.set(key, s);
    if (s.n >= this.max) await new Promise<void>((r) => s.waiting.push(r));
    else s.n++;
    return () => this.give(key, s);
  }

  /** A slot freed: the next waiting takes it (the count stays), else it's one fewer. */
  private give(key: string, s: { n: number; waiting: (() => void)[] }): void {
    const next = s.waiting.shift();
    if (next) return next();
    s.n--;
    if (!s.n) this.busy.delete(key);
  }
}
