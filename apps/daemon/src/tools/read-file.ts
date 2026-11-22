import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fold, under } from "../access/paths.js";

/** What an open path is, its size and change mark, and its text (a file within `max` bytes; else null). */
export type OpenedFile = { kind: "file" | "dir" | "other"; size: number; at: string; text: string | null };

/**
 * Where a followed link may lead (review of 05d5c8b, 2026-11-22): inside `root`, and only to what `accept` takes (the
 * caller's allow-list: your own .md commands, your settings' .json). Names compare as the disk does (any case on macOS).
 */
export type Follow = { root: string; accept: (target: string) => boolean };

const FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

/** A path with its folders resolved (its last part as it is). */
const resolvedDir = (p: string) => join(realpathSync(dirname(p)), basename(p));
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

type Checked = { path: string; dev: number; ino: number };

/** The regular file a link points at, inside `f.root` and accepted, with its identity; else null. */
function linkTarget(path: string, f: Follow): Checked | null {
  try {
    const target = resolvedDir(resolve(dirname(path), readlinkSync(path)));
    if (!under(fold(target), fold(real(f.root)))) return null;
    const st = lstatSync(target);
    if (!st.isFile() || !f.accept(target)) return null;
    return { path: target, dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

/** The file open on `fd` is the one checked, and still at its path (a swap in between is refused). */
function same(fd: number, c: Checked): boolean {
  try {
    const open = fstatSync(fd);
    const now = lstatSync(c.path);
    return open.dev === c.dev && open.ino === c.ino && now.dev === c.dev && now.ino === c.ino;
  } catch {
    return false;
  }
}

/**
 * Opens a path without blocking on a pipe and without following a link (automated review of 9777e0b, 2026-11-22: a
 * FIFO planted at a settings path blocked the daemon). With `follow` (your own dotfiles), a link is followed one hop:
 * its target checked against `follow`, opened the same way (a link to a link isn't) and checked to be the file it
 * checked. Null when it can't be.
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
  let fd: number;
  try {
    fd = openSync(target.path, FLAGS);
  } catch {
    return null;
  }
  if (same(fd, target)) return fd;
  closeSync(fd);
  return null;
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
