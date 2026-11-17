/** A queued start: cancel() before it starts and it never will (true), afterwards it's too late (false). */
export type Queued = { id: number; cancel(): boolean };

/**
 * At most `limit` starts run at once, first in first out. A start holds its slot until its promise settles,
 * so a run's start should resolve when the run ends.
 */
export function createRunQueue(limit: number): {
  enqueue(start: () => Promise<void>): Queued;
  size(): number;
} {
  const waiting: { id: number; start: () => Promise<void> }[] = [];
  let running = 0;
  let next = 0;
  const pump = (): void => {
    while (running < limit && waiting.length > 0) {
      const item = waiting.shift()!;
      running++;
      void item
        .start()
        .catch(() => {})
        .finally(() => {
          running--;
          pump();
        });
    }
  };
  return {
    enqueue(start) {
      const id = ++next;
      waiting.push({ id, start });
      queueMicrotask(pump);
      return {
        id,
        cancel: () => {
          const i = waiting.findIndex((w) => w.id === id);
          if (i < 0) return false;
          waiting.splice(i, 1);
          return true;
        },
      };
    },
    size: () => waiting.length,
  };
}

/** resources.max_runs: a number, or "auto" = half the cores, at least one. */
export function maxRuns(setting: number | "auto", cores: number): number {
  return setting === "auto" ? Math.max(1, Math.floor(cores / 2)) : setting;
}
