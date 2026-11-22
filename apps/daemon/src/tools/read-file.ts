import { closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** What an open path is, its size and change mark, and its text (a file within `max` bytes; else null). */
export type OpenedFile = { kind: "file" | "dir" | "other"; size: number; at: string; text: string | null };

/** Where a followed link may lead: inside `root`, never inside a folder in `deny` (your keys, ion's folders). */
export type Follow = { root: string; deny?: string[] };

const FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

/** `p` inside `dir` (or `dir` itself). */
const inside = (p: string, dir: string) => {
  const r = relative(dir, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/** A path with its folders resolved (its last part as it is). */
const resolvedDir = (p: string) => join(realpathSync(dirname(p)), basename(p));
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** The file a link points at, when it lies inside `f.root` and outside every `f.deny`; else null. */
function linkTarget(path: string, f: Follow): string | null {
  try {
    const target = resolvedDir(resolve(dirname(path), readlinkSync(path)));
    if (!inside(target, real(f.root))) return null;
    return (f.deny ?? []).some((d) => inside(target, real(d))) ? null : target;
  } catch {
    return null;
  }
}

/**
 * Opens a path without blocking on a pipe and without following a link (automated review of 9777e0b, 2026-11-22: a
 * FIFO planted at a settings path blocked the daemon). With `follow` (your own dotfiles), a link is followed one hop:
 * its target checked against `follow`, then opened the same way (a link to a link isn't). Null when it can't be.
 */
export function openNoBlock(path: string, follow?: Follow): number | null {
  try {
    return openSync(path, FLAGS);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (!follow || (code !== "ELOOP" && code !== "EMLINK")) return null;
  }
  const target = linkTarget(path, follow);
  if (!target) return null;
  try {
    return openSync(target, FLAGS);
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
  o: { follow?: Follow } = {},
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
