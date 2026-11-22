import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ToolType } from "@ion/schema";

/**
 * Where something added with ion's commands came from and who added it: kept in ion's data folder (mcp.json stays
 * standard), by kind, name and what it runs. Once it runs something else, the record no longer applies.
 */
type AddedRecord = {
  kind: ToolType;
  name: string;
  /** What it ran when it was added (`launchHash`). */
  hash: string;
  source?: string;
  /** The chat whose agent added it; none: you did. */
  chatId?: string;
  /** Where its source opens (a link given, or a registry id's repo). */
  link?: string;
  at: string;
};

export type Added = {
  find(kind: ToolType, name: string, hash: string): AddedRecord | null;
  put(r: AddedRecord): void;
  drop(kind: ToolType, name: string): void;
};

const MOST = 1000;

/**
 * Writes a file whole and swaps it in, so it's never read half-written: through a link to the file it points at (the
 * link stays), the temp file made fresh (Task review, 2026-11-21: never written through one left in its place).
 */
export function replaceFile(path: string, text: string): void {
  const real = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(real), { recursive: true, mode: 0o700 });
  const tmp = `${real}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  renameSync(tmp, real);
}

/**
 * What Settings has shown as New (kind, id and what it runs): it isn't New again. `state`: "empty" when nothing was
 * ever recorded, "unreadable" when the file is there but can't be read (never taken for empty; final review,
 * 2026-11-22), else "ok".
 */
export type Seen = {
  has(key: string): boolean;
  add(keys: string[]): void;
  state(): "empty" | "ok" | "unreadable";
};

export function createSeen(file: string): Seen {
  const read = (): string[] | "missing" | "unreadable" => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    }
    try {
      const v: unknown = JSON.parse(text);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : "unreadable";
    } catch {
      return "unreadable";
    }
  };
  const all = (): string[] => {
    const r = read();
    return Array.isArray(r) ? r : [];
  };
  return {
    has: (key) => all().includes(key),
    add(keys) {
      const now = all();
      const fresh = keys.filter((k) => !now.includes(k));
      if (fresh.length) replaceFile(file, JSON.stringify([...now, ...fresh].slice(-MOST * 5)));
    },
    state() {
      const r = read();
      if (r === "unreadable") return "unreadable";
      return r === "missing" || r.length === 0 ? "empty" : "ok";
    },
  };
}

/** A short fingerprint of what something runs (a server's launch, a hook's event and command, a skill's folder). */
export const launchHash = (launch: unknown): string =>
  createHash("sha256").update(JSON.stringify(launch)).digest("hex").slice(0, 32);

/** The records in `file` (ion's data folder): read on each ask, written whole and swapped in. */
export function createAdded(file: string): Added {
  const all = (): AddedRecord[] => {
    try {
      const v: unknown = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(v) ? (v as AddedRecord[]) : [];
    } catch {
      return [];
    }
  };
  const save = (rs: AddedRecord[]) => replaceFile(file, JSON.stringify(rs.slice(-MOST)));
  const others = (kind: ToolType, name: string) => all().filter((r) => r.kind !== kind || r.name !== name);
  return {
    find: (kind, name, hash) =>
      all().find((r) => r.kind === kind && r.name === name && r.hash === hash) ?? null,
    put: (r) => save([...others(r.kind, r.name), r]),
    drop: (kind, name) => save(others(kind, name)),
  };
}
