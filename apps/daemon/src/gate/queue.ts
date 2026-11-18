const TTL_MS = 10_000;

type Entry = { kind: string; at: number };

/**
 * Calls the gate allowed, per run, so the harness's own permission prompt that follows (within milliseconds)
 * can be answered from them without a second record. An allow only answers a prompt for the same kind of call
 * (command, read, edit…) in the same run within 10 s: a hook and a prompt describe a call differently, so the
 * exact input can't be matched. Only allows are kept: a denied call never runs, so it never prompts.
 */
export class GateAllows {
  private readonly byRun = new Map<string, Entry[]>();

  constructor(private readonly now: () => number = Date.now) {}

  add(runId: string, kind: string): void {
    this.byRun.set(runId, [...this.fresh(runId), { kind, at: this.now() }]);
  }

  /** True (and used up) when the gate allowed a call of this kind in this run within the last 10 s. */
  take(runId: string, kind: string): boolean {
    const list = this.fresh(runId);
    const i = list.findIndex((e) => e.kind === kind);
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
