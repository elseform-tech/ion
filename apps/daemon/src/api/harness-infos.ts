import type { HarnessInfo } from "@ion/schema";

type Entry = { info: HarnessInfo; at: number; reading?: Promise<void> };

/**
 * What each agent is (installed, signed in, its models), kept: asking an agent's CLI takes seconds (Claude's
 * model list most of all). A known agent is answered at once; one read longer ago than `maxAgeMs` is read again in
 * the background, and the next list has the new answer.
 */
export class HarnessInfos {
  private readonly known = new Map<string, Entry>();
  /** First reads still going (nothing known yet), so a list waits on them instead of starting its own. */
  private readonly first = new Map<string, Promise<void>>();
  /** When the first reads began (the warm-up, or the first ask that waits on them). */
  private since: number | undefined;

  constructor(
    private readonly ids: (() => string[]) | string[],
    private readonly load: (id: string) => Promise<HarnessInfo>,
    private readonly o: { maxAgeMs: number; now?: () => number } = { maxAgeMs: 60_000 },
  ) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private idList(): string[] {
    return typeof this.ids === "function" ? this.ids() : this.ids;
  }

  async list(): Promise<HarnessInfo[]> {
    return Promise.all(this.idList().map((id) => this.get(id)));
  }

  /** What's known now, without waiting for a first read (one read long ago is read again in the background). */
  cached(): HarnessInfo[] {
    const ids = this.idList();
    for (const id of ids) {
      const e = this.known.get(id);
      if (!e || (this.now() - e.at > this.o.maxAgeMs && !e.reading)) void this.read(id);
    }
    return ids.map((id) => this.known.get(id)?.info).filter((i): i is HarnessInfo => !!i);
  }

  /**
   * What's known once the first reads are done, waiting `maxMs` at most (a fresh daemon's first `ion status` has its
   * agents' lines; one slow agent can't hold it longer).
   */
  async settled(maxMs: number): Promise<HarnessInfo[]> {
    this.cached();
    // Only a fresh start waits: the window opens at the first ask (or the warm-up) and closes `maxMs` later.
    this.since ??= this.now();
    const left = this.since + maxMs - this.now();
    if (left <= 0) return this.cached();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((r) => {
      timer = setTimeout(r, left);
    });
    await Promise.race([Promise.allSettled([...this.first.values()]), late]);
    clearTimeout(timer);
    return this.cached();
  }

  /**
   * What's known, waiting `maxMs` at most for first reads still going (ion's limit question can't wait on a slow
   * agent's sign-in check: the controller's end-to-end check, 2026-11-23).
   */
  async soon(maxMs: number): Promise<HarnessInfo[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((r) => {
      timer = setTimeout(r, maxMs);
    });
    await Promise.race([this.list().catch(() => {}), late]);
    clearTimeout(timer);
    return this.cached();
  }

  /** One agent ion knows (read alone), or undefined. */
  async one(id: string): Promise<HarnessInfo | undefined> {
    return this.idList().includes(id) ? this.get(id) : undefined;
  }

  /** Reads every agent now, so the first list is quick (at the daemon's start). */
  warm(): void {
    this.since ??= this.now();
    for (const id of this.idList()) void this.read(id);
  }

  private async get(id: string): Promise<HarnessInfo> {
    const e = this.known.get(id);
    if (!e) {
      await this.read(id);
      return this.known.get(id)!.info;
    }
    if (this.now() - e.at > this.o.maxAgeMs && !e.reading) void this.read(id);
    return e.info;
  }

  private read(id: string): Promise<void> {
    const e = this.known.get(id);
    if (e?.reading) return e.reading;
    const going = this.first.get(id);
    if (!e && going) return going;
    const reading = this.load(id).then(
      (info) => void this.known.set(id, { info, at: this.now() }),
      () => {
        if (e) this.known.set(id, { info: e.info, at: this.now() });
      },
    );
    if (e) e.reading = reading;
    else
      this.first.set(
        id,
        reading.finally(() => this.first.delete(id)),
      );
    return reading;
  }
}
