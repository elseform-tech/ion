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

  /** Reads every agent now, so the first list is quick (at the daemon's start). */
  warm(): void {
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
