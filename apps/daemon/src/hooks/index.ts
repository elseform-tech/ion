import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { RunSandbox } from "@ion/adapter-kit";
import { type HookEntry, loadUserConfig, type UserConfig } from "@ion/config";
import { EV, type HookEvent, type HookLast, type IonEvent, stripControl } from "@ion/schema";
import type { Sign } from "../secrets/consent-key.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { hookEnv, type HookResult, runHook, stopHooks } from "../workspace/hooks.js";
import { hookEventOf } from "./catalog.js";
import { maskKeys } from "./mask.js";
import { activeHooks, endedByIon, projectOf, Slots } from "./parts.js";

export { BUILT_IN, CATALOG } from "./catalog.js";

/**
 * How long a hook may run: a minute, and 10 seconds before a tool runs (the call waits for it), 15 seconds for all of
 * one call's hooks together; at most 4 hook processes at once for one run.
 */
export const LIMITS = { eventMs: 60_000, beforeMs: 10_000, budgetMs: 15_000, perRun: 4 };
/** The stream each hook's runs are kept on (`hook.ran`). */
const STREAM = "hooks";
const NOTIFY = "notify";
/** What your "Before a tool runs" hooks say of a call: refuse it (one exited 2), or that a check didn't finish. */
export type BeforeAnswer = { reason: string } | { failed: true } | null;
/** How much of a refusal's stderr the agent is told. */
const REASON_MAX = 300;
/** How many recent runs are read back at start, for each hook's last result. */
const LAST_READ = 2000;

type Run = { chatId: string; runId: string; projectId: string };
type Call = { toolName: string; kind: string; summary: string; input: Record<string, unknown> };
/** Where an event happened: its project (id and name) and chat (id and title), when it has them. */
type Where = { projectId: string | null; project: string | null; chatId: string | null; chat: string | null };
type Job = () => Promise<void>;

const dayOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const failedBody = (name: string, timedOut: boolean) =>
  timedOut ? `The hook “${name}” took too long` : `The hook “${name}” failed`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();

/**
 * Your hooks on ion's events: each event's hooks (turned on in the app for what they run now, for the event's
 * project or every project) run in the project's folder, one at a time per hook (one more waits, the rest are
 * dropped). "Before a tool runs" hooks run in order for each call; the first that exits 2 refuses it. Each run is
 * kept as `hook.ran` (keys masked); a hook that fails or takes too long is said once a day, as a notification.
 */
export class Hooks {
  private readonly slots = new Map<string, { next?: Job }>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly lasts = new Map<string, HookLast>();
  private readonly reported = new Map<string, string>();
  /** The process group of every hook running now (all stopped when ion stops). */
  private readonly live = new Set<number>();
  private readonly limits: typeof LIMITS;
  private readonly now: () => Date;
  private readonly perRun: Slots;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(
    private readonly o: {
      store: EventStore;
      db: Db;
      configFile: string;
      /** Signs consent records with this install's key (a hook is on only with a record that verifies). */
      sign: Sign;
      limits?: typeof LIMITS;
      now?: () => Date;
      /** Masks your keys in what's kept of a hook's output. */
      mask?: (text: string) => Promise<string>;
      /** The OS sandbox hooks run in: ion's folders out of reach (Plan 18 Task 12). */
      sandbox?: RunSandbox;
    },
  ) {
    this.limits = o.limits ?? LIMITS;
    this.now = o.now ?? (() => new Date());
    this.perRun = new Slots(this.limits.perRun);
    for (const e of o.store.read({ chatId: STREAM, types: [EV.hookRan], newest: true, limit: LAST_READ })) {
      const d = e.data as { hookId: string; ok: boolean; code: number | null; tail: string };
      this.lasts.set(d.hookId, { ok: d.ok, at: e.ts, code: d.code, tail: d.tail });
    }
  }

  /** Listens to every stored event; returns how to stop. */
  start(): () => void {
    this.stopped = false;
    const off = this.o.store.onAppend((e) => this.heard(e));
    this.unsubscribe = off;
    return off;
  }

  /** ion stops: hooks hear nothing more; every running hook is stopped, with all it started. */
  readonly stop = (): void => {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const s of this.slots.values()) delete s.next;
    stopHooks(this.live);
  };

  /** A hook's last run, if it ran. */
  last(id: string): HookLast | undefined {
    return this.lasts.get(id);
  }

  /** Resolves once no hook is running or waiting (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /**
   * A tool call about to run: your "Before a tool runs" hooks for the run's project, in order, each up to 10
   * seconds and 15 in all (the rest are skipped after that), at most 4 hook processes at once for the run. The first
   * that exits 2 refuses it, with the start of its stderr as the reason. One that fails, hangs or is skipped lets the
   * call go on (reported), and Auto-approval is told in one line.
   */
  beforeTool(run: Run, call: Call): Promise<BeforeAnswer> {
    return this.track(this.before(run, call));
  }

  private async before(run: Run, call: Call): Promise<BeforeAnswer> {
    const c = this.config();
    const { list, unverified } = await activeHooks(c, this.o.sign, {
      event: "tool.before",
      projectId: run.projectId,
    });
    // Hooks ion couldn't check, or ion stopping: the call isn't let through as if they'd said yes.
    if (this.stopped) return list.length || unverified ? { failed: true } : null;
    const where = this.where(c, run.projectId, run.chatId);
    const data = { tool: call.toolName, kind: call.kind, summary: call.summary, input: call.input };
    const payload = { type: "tool.before", chatId: run.chatId, runId: run.runId, data };
    const started = Date.now();
    let missed = unverified;
    for (const h of list) {
      const r = await this.beforeOne(run.runId, h, { ...where, started }, payload);
      if (r?.code === 2) return { reason: await this.reasonOf(h, r) };
      if (!r || r.code !== 0) missed = true;
    }
    return missed ? { failed: true } : null;
  }

  /**
   * One hook on a call, in one of the run's slots, within what's left of the call's budget once its turn comes
   * (null: none left, so it's skipped).
   */
  private async beforeOne(runId: string, h: HookEntry, w: Where & { started: number }, payload: object) {
    const give = await this.perRun.take(runId);
    try {
      const left = this.limits.budgetMs - (Date.now() - w.started);
      if (left <= 0 || this.stopped) return null;
      const limitMs = Math.min(this.limits.beforeMs, left);
      return await this.runOne(h, "tool.before", payload, { ...w, limitMs });
    } finally {
      give();
    }
  }

  private heard(e: IonEvent): void {
    const event = hookEventOf(e);
    if (!event || this.stopped) return;
    // A run ion's own stop or restart ended: the chat didn't fail.
    if (event === "run.failed" && endedByIon(this.o.store, e.runId)) return;
    void this.track(this.startFor(event, e)).catch((err: Error) => {
      // A hook that couldn't be started never stops what raised the event.
      console.warn(`ion couldn't run hooks: ${err.message}`);
    });
  }

  private async startFor(event: HookEvent, e: IonEvent): Promise<void> {
    const c = this.config();
    const projectId = projectOf(this.o.db, e);
    const where = this.where(c, projectId, e.chatId);
    const { list } = await activeHooks(c, this.o.sign, { event, projectId });
    for (const h of list)
      this.queue(h.id, async () => {
        await this.runOne(h, event, e, where);
      });
  }

  /** One at a time per hook: one more waits; the rest are dropped. */
  private queue(id: string, job: Job): void {
    const slot = this.slots.get(id);
    if (slot) {
      slot.next ??= job;
      return;
    }
    this.slots.set(id, {});
    void this.track(this.drain(id, job));
  }

  private async drain(id: string, first: Job): Promise<void> {
    let job: Job | undefined = first;
    while (job && !this.stopped) {
      await job().catch(() => {});
      const slot = this.slots.get(id);
      job = slot?.next;
      if (slot) delete slot.next;
    }
    this.slots.delete(id);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p)).catch(() => {});
    return p;
  }

  /** One hook's run, up to `w.limitMs` (else a minute), kept as `hook.ran`; a failure is reported. */
  private async runOne(
    h: HookEntry,
    event: HookEvent,
    payload: object,
    w: Where & { limitMs?: number },
  ): Promise<HookResult> {
    const before = event === "tool.before";
    const r = await runHook({
      live: this.live,
      run: h.run,
      stdin: JSON.stringify({ ...payload, project: w.project, chat: w.chat }),
      env: hookEnv({
        event,
        ...(w.projectId ? { project: w.projectId } : {}),
        ...(w.chatId ? { chat: w.chatId } : {}),
      }),
      cwd: this.cwdOf(w.projectId),
      limitMs: w.limitMs ?? this.limits.eventMs,
      ...(this.o.sandbox ? { sandbox: this.o.sandbox } : {}),
    });
    const ok = r.code === 0 || (before && r.code === 2);
    const tail = await this.mask(r.tail);
    const at = this.now().toISOString();
    this.o.store.append({
      chatId: STREAM,
      runId: null,
      origin: "daemon",
      type: EV.hookRan,
      data: { hookId: h.id, ok, code: r.code, ms: r.ms, tail },
    });
    this.lasts.set(h.id, { ok, at, code: r.code, tail });
    if (!ok) this.report(h, r.timedOut);
    return r;
  }

  private mask(text: string): Promise<string> {
    if (!text) return Promise.resolve(text);
    return (this.o.mask ?? ((t: string) => maskKeys(t, this.o.configFile)))(text).catch(() => "");
  }

  private async reasonOf(h: HookEntry, r: HookResult): Promise<string> {
    const said = stripControl(r.stderr).replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
    return said ? await this.mask(said) : `The hook “${h.name}” said no`;
  }

  /**
   * A hook that failed: said once a day per hook, never on every event. Across a restart: a failure of this hook
   * earlier today (its runs are kept) was said then.
   */
  private report(h: HookEntry, timedOut: boolean): void {
    const now = this.now();
    const day = dayOf(now);
    if (this.reported.get(h.id) === day) return;
    this.reported.set(h.id, day);
    const failures = this.o.store
      .read({ chatId: STREAM, types: [EV.hookRan], since: startOfDay(now) })
      .filter((e) => {
        const d = e.data as { hookId?: unknown; ok?: unknown };
        return d.hookId === h.id && d.ok === false;
      });
    if (failures.length > 1) return;
    const data = { title: "ion", body: failedBody(h.name, timedOut).slice(0, 400), kind: "needs" };
    this.o.store.append({ chatId: NOTIFY, runId: null, origin: "daemon", type: EV.notify, data });
  }

  private config(): UserConfig {
    return loadUserConfig(this.o.configFile).config;
  }

  private where(c: UserConfig, projectId: string | null, chatId: string | null): Where {
    const p = projectId ? c.projects.find((x) => x.id === projectId) : undefined;
    const chat = chatId ? chatsView.list(this.o.db).find((x) => x.chatId === chatId) : undefined;
    return { projectId, project: p ? (p.name ?? p.id) : null, chatId, chat: chat?.title ?? null };
  }

  /** The project's folder, else ion's home folder. */
  private cwdOf(projectId: string | null): string {
    const p = projectId ? this.config().projects.find((x) => x.id === projectId) : undefined;
    return p && existsSync(p.path) ? p.path : dirname(this.o.configFile);
  }
}
