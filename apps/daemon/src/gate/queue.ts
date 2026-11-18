const TTL_MS = 2000;

/** What a prompt and the gate's allow are matched on. */
export type CallKey = { kind: string; command?: string };
type Entry = CallKey & { at: number };

/**
 * Calls the gate allowed, per run, so the harness's own permission prompt that follows (within milliseconds)
 * can be answered from them without a second record. An allow answers only a prompt for the same kind of call
 * (and the same command, when both name one) in the same run within 2 s: a hook and a prompt describe a call
 * differently, so their whole inputs can't be matched. Only allows are kept: a denied call never prompts.
 */
export class GateAllows {
  private readonly byRun = new Map<string, Entry[]>();

  constructor(private readonly now: () => number = Date.now) {}

  add(runId: string, key: CallKey): void {
    this.byRun.set(runId, [...this.fresh(runId), { ...key, at: this.now() }]);
  }

  /** True (and used up) when the gate allowed a matching call in this run within the last 2 s. */
  take(runId: string, key: CallKey): boolean {
    const list = this.fresh(runId);
    const i = list.findIndex(
      (e) =>
        e.kind === key.kind &&
        (e.command === undefined || key.command === undefined || e.command === key.command),
    );
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
