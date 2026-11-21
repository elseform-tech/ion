import { readFileSync, writeFileSync } from "node:fs";

/** How often, and over how long, before ion says Auto is often unsure about one kind of action. */
const TIMES = 5;
const WINDOW_MS = 7 * 86_400_000;
const NOTE = "Auto often isn't sure about: ";
const MAX_KINDS = 200;

type Action = { toolName: string; kind: string; input: Record<string, unknown> };

/** One kind of action: a command's first word (and its subcommand), else the tool's name. */
export function kindOfAction(a: Action): string {
  const command = a.input.command;
  if (a.kind === "mcp" || typeof command !== "string") return a.toolName.slice(0, 80);
  const [first = a.toolName, second] = command.trim().split(/\s+/);
  // A subcommand only after a program's bare name (npm publish), not a script's arguments (./deploy.sh prod).
  const bare = /^[a-z][\w-]*$/.test(first);
  const sub = bare && second && /^[a-z][a-z0-9-]*$/.test(second) ? ` ${second}` : "";
  return `${first}${sub}`.slice(0, 80);
}

type Saved = { seen: Record<string, number[]>; noted: string[] };

/**
 * The judge's unsure answers by kind of action, kept in a file (the user, 2026-11-21): 5 in 7 days on one kind is
 * noted once (in the log and `ion status`), so a rule can be added for it.
 */
export class UnsureLog {
  private readonly saved: Saved;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.saved = load(file);
  }

  /** Counts one unsure answer; the note, the first time this kind reaches 5 in 7 days, else null. */
  add(a: Action): string | null {
    const kind = kindOfAction(a);
    const since = this.now() - WINDOW_MS;
    const times = [...(this.saved.seen[kind] ?? []).filter((t) => t > since), this.now()];
    this.saved.seen[kind] = times;
    this.trim(since);
    const note = times.length >= TIMES && !this.saved.noted.includes(kind);
    if (note) this.saved.noted.push(kind);
    this.save();
    return note ? `${NOTE}${kind}` : null;
  }

  /** What's been noted, one line each. */
  notes(): string[] {
    return this.saved.noted.map((k) => `${NOTE}${k}`);
  }

  /** Old answers go; at most MAX_KINDS kinds are kept. */
  private trim(since: number): void {
    for (const [k, ts] of Object.entries(this.saved.seen)) {
      const kept = ts.filter((t) => t > since);
      if (kept.length) this.saved.seen[k] = kept;
      else delete this.saved.seen[k];
    }
    const kinds = Object.keys(this.saved.seen);
    for (const k of kinds.slice(0, Math.max(0, kinds.length - MAX_KINDS))) delete this.saved.seen[k];
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.saved));
    } catch {
      // kept in memory only
    }
  }
}

function load(file: string): Saved {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>;
    const seen = v.seen && typeof v.seen === "object" ? v.seen : {};
    return { seen, noted: Array.isArray(v.noted) ? v.noted.filter((n) => typeof n === "string") : [] };
  } catch {
    return { seen: {}, noted: [] };
  }
}
