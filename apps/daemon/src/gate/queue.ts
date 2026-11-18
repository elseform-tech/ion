const TTL_MS = 2000;

/** What a prompt and the gate's allow are matched on: the kind of call and its command or file. */
export type CallKey = { kind: string; id?: string };
type Entry = CallKey & { at: number };

/**
 * Calls the gate allowed, per run, so the harness's own permission prompt that follows (within milliseconds)
 * can be answered from them without a second record. An allow answers only a prompt for the same kind of call
 * with the same command or file, in the same run, within 2 s; a call with neither is never kept (its prompt is
 * decided in full). Only allows are kept: a denied call never prompts.
 */
export class GateAllows {
  private readonly byRun = new Map<string, Entry[]>();

  constructor(private readonly now: () => number = Date.now) {}

  add(runId: string, key: CallKey): void {
    if (key.id === undefined) return;
    this.byRun.set(runId, [...this.fresh(runId), { ...key, at: this.now() }]);
  }

  /** True (and used up) when the gate allowed a matching call in this run within the last 2 s. */
  take(runId: string, key: CallKey): boolean {
    const list = this.fresh(runId);
    const i = key.id === undefined ? -1 : list.findIndex((e) => e.kind === key.kind && e.id === key.id);
    if (i >= 0) list.splice(i, 1);
    this.byRun.set(runId, list);
    return i >= 0;
  }

  drop(runId: string): void {
    this.byRun.delete(runId);
  }

  private fresh(runId: string): Entry[] {
    const since = this.now() - TTL_MS;
    return (this.byRun.get(runId) ?? []).filter((e) => e.at > since);
  }
}
