/**
 * Batches streamed text so a long answer becomes a few events instead of thousands.
 * Flushes after `ms` since the first buffered delta, or once the buffer reaches `bytes`.
 */
export function createDeltaCoalescer(
  flush: (text: string) => void,
  opts: { ms?: number; bytes?: number } = {},
): { push(text: string): void; end(): void } {
  const ms = opts.ms ?? 50;
  const bytes = opts.bytes ?? 2048;
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const drain = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!buffer) return;
    const text = buffer;
    buffer = "";
    flush(text);
  };
  return {
    push(text) {
      buffer += text;
      if (buffer.length >= bytes) return drain();
      timer ??= setTimeout(drain, ms);
    },
    end: drain,
  };
}
