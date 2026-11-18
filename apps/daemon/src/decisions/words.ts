const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
/** How much two questions share their words (0–1): a check the matcher's model can't talk its way past. */
export function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  const both = [...x].filter((w) => y.has(w)).length;
  return both / Math.max(1, new Set([...x, ...y]).size);
}
export const SAME_QUESTION = 0.5;
