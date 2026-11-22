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
import { DREAM_SKIPPED } from "../ions/dream.js";
import { type IonTurns, NO_AGENT, TOO_LONG } from "../ions/turn.js";

/** How often ion looks whether it's time to dream. */
const LOOK_MS = 60_000;

/**
 * ion's dream on its schedule (Settings → Memory: off, nightly or weekly): at 3:00 local, or (a night missed) the
 * next time ion is up in quiet hours; once a night at most, one dream turn at a time.
 */
export class Dreams {
  private running = false;

  constructor(private readonly d: DreamDeps) {}

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
    if (this.running) return;
    const { config, error } = loadUserConfig(this.d.configFile);
    const night = error ? null : dreamDue(config, new Date(), servedPeriods(this.d.store));
    if (night)
      await this.now(night).catch((e: unknown) => console.error(`ion's dream: ${(e as Error).message}`));
  }
}

/** A dream's turn as one of ion's turns: memory's tools only, no threads; how it ended, from its reply. */
export function dreamThink(turns: Pick<IonTurns, "turn">): DreamDeps["think"] {
  return async (prompt, dream) => {
    const { reply } = await turns.turn(DREAM_ION, prompt, { noThreads: true, dream });
    let status: DreamTurn["status"] = "done";
    if (reply === TOO_LONG) status = "late";
    else if (reply === NO_AGENT || reply.startsWith(DREAM_SKIPPED)) status = "failed";
    return { reply, status };
  };
}
