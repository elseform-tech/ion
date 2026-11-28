import { loadUserConfig } from "@ion/config";
import type { DreamInfo } from "@ion/schema";
import { UserError } from "../api/errors.js";
import { DREAM_ION } from "../memory/dream-rules.js";
import {
  closeCutOff,
  type DreamDeps,
  type DreamTurn,
  dreamDue,
  runDream,
  servedPeriods,
} from "../memory/dream.js";
import { type IonTurns, noAgent } from "../ions/turn.js";

/** How often ion looks whether it's time to dream. */
const LOOK_MS = 60_000;

/**
 * ion's dream on its schedule (Settings → Memory: off, nightly or weekly): at 3:00 local, or (a night missed) the
 * next time ion is up in quiet hours; once a night at most, one dream turn at a time.
 */
export class Dreams {
  private running = false;
  /** Something else that runs at night (the agents' check): tidying waits for it (Plan 21 final review, M10). */
  private busy: () => boolean = () => false;

  constructor(private readonly d: DreamDeps) {}

  /** Whether it's tidying now. */
  get tidying(): boolean {
    return this.running;
  }

  /** Tidying on its schedule waits while `busy` says so. */
  waitFor(busy: () => boolean): void {
    this.busy = busy;
  }

  /** Looks every minute; returns a stop. */
  start(): () => void {
    closeCutOff(this.d.store);
    const timer = setInterval(() => void this.tick(), LOOK_MS);
    return () => clearInterval(timer);
  }

  /** Dreams now (`memory.dream`, out of turn; or `period`: that night's); refused while a dream is going. */
  async now(period?: string): Promise<DreamInfo> {
    if (this.running) throw new UserError("ion is tidying memory already");
    this.running = true;
    try {
      return await runDream(this.d, period);
    } finally {
      this.running = false;
    }
  }

  private async tick(): Promise<void> {
    if (this.running || this.busy()) return;
    const { config, error } = loadUserConfig(this.d.configFile);
    const night = error ? null : dreamDue(config, new Date(), servedPeriods(this.d.store));
    if (night)
      await this.now(night).catch((e: unknown) => console.error(`ion's dream: ${(e as Error).message}`));
  }
}

/** A dream's turn as one of ion's turns: memory's tools only, no threads; how it ended, from its reply. */
export function dreamThink(turns: Pick<IonTurns, "turn">): DreamDeps["think"] {
  return async (prompt, dream) => {
    const r = await turns.turn(DREAM_ION, prompt, { noThreads: true, dream });
    const { reply } = r;
    // ion's own mark says how it ended (security scan, 2026-11-22: never the reply's words).
    let status: DreamTurn["status"] = "done";
    if (r.ionLine === "late") status = "late";
    else if (noAgent(r) || r.ionLine === "skipped") status = "failed";
    return { reply, status };
  };
}
