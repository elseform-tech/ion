import {
  DEFAULT_PROJECT,
  loadUserConfig,
  type RoutineEntry,
  saveUserConfig,
  updateRoutine,
} from "@ion/config";
import { EV, nextRun } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { Db, EventStore } from "../store/index.js";
import { routinesView } from "../views/routines.js";

/** How often ion looks for a routine that's due. */
const TICK_MS = 30_000;

/** Starts a routine's thread, as its ion does: the thread, or why it couldn't. */
export type StartThread = (
  projectId: string,
  r: RoutineEntry,
  by: "schedule" | "you",
) => Promise<{ chatId: string } | { why: string }>;

type Ran = {
  projectId: string;
  routineId: string;
  name: string;
  due: string | null;
  by: "schedule" | "you";
  chatId?: string;
  why?: string;
  skipped?: true;
};

const keyOf = (projectId: string, routineId: string) => `${projectId}/${routineId}`;

/**
 * Runs each project's routines when they're due, as a thread its ion starts. A slot runs at most once (each one ran
 * is a `routine.ran`, so a restart knows); the slots missed while ion was stopped run once, as the latest. A routine
 * that's off, or every routine while paused, lets its slots pass; turned on again, it waits for its next one.
 */
export class Routines {
  /** Per routine: no slot at or before this time runs (it was off, paused, or just changed). */
  private readonly held = new Map<string, number>();
  /** A routine that never ran waits for its first slot after ion started. */
  private readonly bootedAt = Date.now();
  private ticking = false;

  constructor(private readonly d: { store: EventStore; db: Db; configFile: string; start: StartThread }) {}

  /** Looks now (a run missed while ion was stopped goes now), then every 30 seconds. Returns stop. */
  start(): () => void {
    const timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
    return () => clearInterval(timer);
  }

  /** After you add, change or turn on a routine (no `routineId`: every one, after pause all): no catching up. */
  hold(projectId?: string, routineId?: string): void {
    const now = Date.now();
    for (const p of this.projects())
      for (const r of p.routines ?? [])
        if ((!projectId || p.id === projectId) && (!routineId || r.id === routineId))
          this.held.set(keyOf(p.id, r.id), now);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date();
      const paused = this.paused();
      for (const p of this.projects()) for (const r of p.routines ?? []) await this.due(p.id, r, now, paused);
    } finally {
      this.ticking = false;
    }
  }

  /** Runs a routine now, whatever its schedule (which stays): its thread. */
  async run(projectId: string, routineId: string): Promise<{ chatId: string }> {
    const r = this.projects()
      .find((p) => p.id === projectId)
      ?.routines?.find((x) => x.id === routineId);
    if (!r) throw new UserError(`Unknown routine: ${routineId}`);
    const t = await this.started(projectId, r, "you");
    this.record({ projectId, routineId, name: r.name, due: null, by: "you", ...t });
    if ("why" in t) throw new UserError(t.why);
    return t;
  }

  /** When it runs next (after the one you skipped); null while it's off or everything is paused. */
  next(r: RoutineEntry): Date | null {
    if (!r.on || this.paused()) return null;
    const n = nextRun(r.when, new Date());
    return r.skip === n.toISOString() ? nextRun(r.when, n) : n;
  }

  paused(): boolean {
    return loadUserConfig(this.d.configFile).config.routines?.paused === true;
  }

  private projects() {
    return loadUserConfig(this.d.configFile).config.projects.filter((p) => p.id !== DEFAULT_PROJECT);
  }

  /** Runs the routine if a slot came since it last ran (or was held): once, for the latest of them. */
  private async due(projectId: string, r: RoutineEntry, now: Date, paused: boolean): Promise<void> {
    const key = keyOf(projectId, r.id);
    const last = routinesView.lastDue(this.d.db, projectId, r.id);
    const from = Math.max(last ? Date.parse(last) : this.bootedAt, this.held.get(key) ?? 0);
    const first = nextRun(r.when, new Date(from));
    if (first > now) return;
    if (!r.on || paused) return void this.held.set(key, now.getTime());
    let slot = first;
    for (let n = nextRun(r.when, slot); n <= now; n = nextRun(r.when, n)) slot = n;
    const ran = {
      projectId,
      routineId: r.id,
      name: r.name,
      due: slot.toISOString(),
      by: "schedule" as const,
    };
    const skip = r.skip ? Date.parse(r.skip) : Number.NaN;
    if (skip >= first.getTime() && skip <= slot.getTime()) {
      this.record({ ...ran, skipped: true });
      return this.spendSkip(projectId, r.id);
    }
    this.record({ ...ran, ...(await this.started(projectId, r, "schedule")) });
  }

  private async started(projectId: string, r: RoutineEntry, by: "schedule" | "you") {
    try {
      return await this.d.start(projectId, r, by);
    } catch (e) {
      return { why: e instanceof UserError ? e.message : "Couldn't start it" };
    }
  }

  /** The skip is used up: it leaves your config. */
  private spendSkip(projectId: string, routineId: string): void {
    const { config, error } = loadUserConfig(this.d.configFile);
    if (error) return;
    saveUserConfig(this.d.configFile, updateRoutine(config, projectId, routineId, { skip: null }));
  }

  private record(data: Ran): void {
    this.d.store.append({ chatId: null, runId: null, origin: "daemon", type: EV.routineRan, data });
  }
}
