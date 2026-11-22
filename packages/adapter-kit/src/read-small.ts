import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

/**
 * A regular file's text, at most `max` bytes, checked and read through one open file (CodeQL on main, 2026-11-22,
 * js/file-system-race in opencode-config.ts: a stat by path, then a read by path, could read another file than the
 * one checked). Opened without blocking, so a pipe at the path can't hang the caller. Null when it's missing, not a
 * file, too big or unreadable.
 */
export function readSmallFile(path: string, max: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    return st.isFile() && st.size <= max ? readFileSync(fd, "utf8") : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
