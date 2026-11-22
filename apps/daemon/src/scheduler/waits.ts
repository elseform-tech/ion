/** setTimeout's longest wait; a later time waits in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * One timed wake-up per key (a chat waiting for its agent's limit to reset): set again, it replaces the last; it
 * runs once, at its time (at once when that's past). Timers never keep ion running.
 */
export class Waits {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  at(key: string, when: Date, fn: () => void): void {
    this.cancel(key);
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
