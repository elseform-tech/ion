/** setTimeout's longest wait; a later time waits in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * One timed wake-up per key (a chat waiting for its agent's limit to reset): set again, it replaces the last; it
 * runs once, at its time (at once when that's past). Timers never keep ion running.
 */
export class Waits {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly refused = new Set<string>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * False when refused: a time that isn't a date would wake at once, again and again (security scan, 2026-11-23); the
   * caller falls back to its own guess. Said once per key.
   */
  at(key: string, when: Date, fn: () => void): boolean {
    this.cancel(key);
    if (!Number.isFinite(when.getTime())) {
      if (!this.refused.has(key)) console.warn(`ion didn't set a wait: its time isn't a date (${key})`);
      this.refused.add(key);
      return false;
    }
    const step = () => {
      const left = when.getTime() - this.now();
      if (left <= 0) {
        this.timers.delete(key);
        fn();
        return;
      }
      const t = setTimeout(step, Math.min(left, MAX_TIMER_MS));
      (t as { unref?: () => void }).unref?.();
      this.timers.set(key, t);
    };
    step();
    return true;
  }

  /** Whether a wake-up is set for this key. */
  has(key: string): boolean {
    return this.timers.has(key);
  }

  cancel(key: string): void {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
  }

  stop(): void {
    for (const key of [...this.timers.keys()]) this.cancel(key);
  }
}
