import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";

/** What an open path is, its size and change mark, and its text (a file within `max` bytes; else null). */
export type OpenedFile = { kind: "file" | "dir" | "other"; size: number; at: string; text: string | null };

/**
 * Opens a path without blocking on a pipe and without following a link (automated review of 9777e0b, 2026-11-22: a
 * FIFO planted at a settings path blocked the daemon). `follow`: the caller's own file that may be a link (your
 * dotfiles): resolved first, deliberately. Null when it can't be opened.
 */
export function openNoBlock(path: string, follow = false): number | null {
  try {
    const at = follow ? realpathSync(path) : path;
    return openSync(at, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
}

const kindOf = (st: { isFile(): boolean; isDirectory(): boolean }): OpenedFile["kind"] => {
  if (st.isFile()) return "file";
  return st.isDirectory() ? "dir" : "other";
};

/**
 * Opens a path once, checks what it is through that open file and reads it from there (CodeQL on PR #25, 2026-11-22,
 * js/file-system-race: a stat by path, then a read by path, could read another file than the one checked). Null when
 * it can't be opened.
 */
export function openFile(
  path: string,
  max: number,
  known?: string,
  o: { follow?: boolean } = {},
): OpenedFile | null {
  const fd = openNoBlock(path, o.follow);
  if (fd === null) return null;
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
