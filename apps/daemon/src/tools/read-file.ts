import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

/** What an open path is, its size and change mark, and its text (a file within `max` bytes; else null). */
export type OpenedFile = { kind: "file" | "dir" | "other"; size: number; at: string; text: string | null };

const kindOf = (st: { isFile(): boolean; isDirectory(): boolean }): OpenedFile["kind"] => {
  if (st.isFile()) return "file";
  return st.isDirectory() ? "dir" : "other";
};

/**
 * Opens a path once, checks what it is through that open file and reads it from there (CodeQL on PR #25, 2026-11-22,
 * js/file-system-race: a stat by path, then a read by path, could read another file than the one checked). Null when
 * it can't be opened.
 */
export function openFile(path: string, max: number, known?: string): OpenedFile | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    const kind = kindOf(st);
    const at = `${st.mtimeMs}:${st.size}`;
    // `known`: the change mark the caller already read it at; the same, it isn't read again.
    const text = kind === "file" && st.size <= max && at !== known ? readFileSync(fd, "utf8") : null;
    return { kind, size: st.size, at, text };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
