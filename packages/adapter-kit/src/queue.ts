/** A push-based async queue: producers push, one consumer iterates. Used for session event streams. */
export interface EventQueue<T> extends AsyncIterable<T> {
  push(item: T): void;
  end(): void;
  fail(error: Error): void;
}

export function createEventQueue<T>(): EventQueue<T> {
  const items: T[] = [];
  let done = false;
  let error: Error | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  return {
    push(item) {
      if (done) return;
      items.push(item);
      notify();
    },
    end() {
      done = true;
      notify();
    },
    fail(e) {
      if (done) return;
      error = e;
      done = true;
      notify();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) {
          yield items.shift() as T;
          continue;
        }
        if (error) throw error;
        if (done) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
  };
}
