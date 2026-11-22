import { readFileSync, writeFileSync } from "node:fs";

const WINDOW_MS = 7 * 86_400_000;

/**
 * Each time an agent's judge didn't answer (too slow, or failed), by agent, kept in a file for 7 days (final review,
 * 2026-11-22): Settings → Agents shows how often.
 */
export class JudgeMisses {
  private seen: Record<string, number[]>;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.seen = load(file);
  }

  add(agent: string): void {
    this.seen[agent] = [...(this.seen[agent] ?? []), this.now()];
    this.trim();
    try {
      writeFileSync(this.file, JSON.stringify(this.seen), { mode: 0o600 });
    } catch {
      // a count that isn't kept changes nothing
    }
  }

  /** Each agent's misses in the last 7 days (agents with none left out). */
  counts(): Record<string, number> {
    this.trim();
    return Object.fromEntries(Object.entries(this.seen).map(([a, ts]) => [a, ts.length]));
  }

  private trim(): void {
    const since = this.now() - WINDOW_MS;
    for (const [a, ts] of Object.entries(this.seen)) {
      const kept = ts.filter((t) => t > since);
      if (kept.length) this.seen[a] = kept;
      else delete this.seen[a];
    }
  }
}

function load(file: string): Record<string, number[]> {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!v || typeof v !== "object") return {};
    const ok = Object.entries(v).filter(
      (e): e is [string, number[]] => Array.isArray(e[1]) && e[1].every((t) => typeof t === "number"),
    );
    return Object.fromEntries(ok);
  } catch {
    return {};
  }
}

let misses: { file: string; m: JudgeMisses } | undefined;

/** The daemon's count, in its data folder (one per file: the judge's users share it). */
export function useJudgeMisses(file: string): JudgeMisses {
  if (misses?.file !== file) misses = { file, m: new JudgeMisses(file) };
  return misses.m;
}

/** An agent's misses this week, for Settings → Agents (none: nothing to show). */
export function missesOf(agent: string): { judgeMisses?: number } {
  const n = misses?.m.counts()[agent] ?? 0;
  return n ? { judgeMisses: n } : {};
}
