export const NOT_RUNNING = "ion isn't running. Start it with: ion daemon start";

export type Out = { json: boolean };

export function print(o: Out, human: string, data: unknown): void {
  console.log(o.json ? JSON.stringify(data) : human);
}

export function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

/** Rows as lined-up columns, two spaces apart; the last column isn't padded. */
export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows
    .map((r) => r.map((cell, i) => (i < r.length - 1 ? cell.padEnd(widths[i]!) : cell)).join("  "))
    .join("\n");
}
