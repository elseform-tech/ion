/**
 * Your "Before a tool runs" hooks, once per tool call. ion checks one call at more than one point (the agent's hook,
 * its permission prompt, ion's gateway); without this, your hooks ran at each, so one with side effects (a counter, a
 * log, a model call) ran twice (plugins research, 2026-11-28). What they said of a call is kept for the run and given
 * to the next point that checks the same call; a point that sees the call again is a new call, and its hooks run.
 */

/** Where ion checks a call: the agent's hook (gate), its permission prompt, ion's gateway. */
export type CheckPoint = "gate" | "prompt" | "gateway";

/**
 * Kept this long from when it arrives (security review, 2026-11-28: 5 minutes from the ask left a stale answer for a
 * later call). A call held for your answer is held before the result exists, at the same point.
 */
const MEMO_MS = 30_000;
/** How many calls are kept for one run (the oldest go first). */
const PER_RUN = 200;

/** `at`: when the hooks' answer arrived (null while they run). */
type Entry<T> = { key: string; at: number | null; seen: Set<CheckPoint>; said: Promise<T> };

export class HookMemo<T> {
  private readonly runs = new Map<string, Entry<T>[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * What your hooks said of this call: from an earlier point that checked the same call in this run (chat and run
   * both), else from `ask`, kept for the points after.
   */
  once(run: { chatId: string; runId: string }, call: { key: string; at: CheckPoint }, ask: () => Promise<T>) {
    const id = `${run.chatId}\n${run.runId}`;
    const now = this.now();
    const list = (this.runs.get(id) ?? []).filter((e) => e.at === null || now - e.at < MEMO_MS);
    // The newest: a prompt follows its own hook's check.
    const earlier = list.findLast((e) => e.key === call.key && !e.seen.has(call.at));
    if (earlier) {
      earlier.seen.add(call.at);
      this.runs.set(id, list);
      return earlier.said;
    }
    const said = ask();
    const entry: Entry<T> = { key: call.key, at: null, seen: new Set([call.at]), said };
    void said.then(
      () => (entry.at = this.now()),
      () => (entry.at = this.now()),
    );
    list.push(entry);
    this.runs.set(id, list.slice(-PER_RUN));
    return said;
  }

  /** The run ended: what its hooks said goes. */
  drop(runId: string): void {
    for (const id of this.runs.keys()) if (id.endsWith(`\n${runId}`)) this.runs.delete(id);
  }
}
