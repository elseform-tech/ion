import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEMORY_PATH,
  MEMORY_SLUG,
  MEMORY_TEXT_MAX,
  type MemoryHeader,
  MemoryHeaderSchema,
  type MemoryScope,
  type MemorySee,
  type MemoryType,
} from "@ion/schema";
import { isMap, isScalar, parseDocument, Scalar, stringify } from "yaml";
import { UserError } from "../api/errors.js";
import { openFile } from "../tools/read-file.js";

/** A memory file as read: where it is, its header (and the keys ion doesn't know), its text and its hash. */
export type MemoryFile = {
  path: string;
  scope: MemoryScope;
  slug: string;
  header: MemoryHeader;
  extra: Record<string, string>;
  text: string;
  hash: string;
};

/** A file read, or why not; `gone`: there's no file there. */
export type FileRead = { ok: true; file: MemoryFile } | { ok: false; gone: boolean; problem: string };

/** A header as given to a write: `see` defaults by scope and type. */
type HeaderInput = Omit<MemoryHeader, "see"> & { see?: MemorySee };

export type FileWrite = {
  scope: MemoryScope;
  /** The file to change; none: a new file, named after the header's name. */
  slug?: string;
  header: HeaderInput;
  text: string;
  /** The hash the writer read the file at: it's written only if the file is still that. */
  expectHash?: string;
  /** Moving old notes only: a folder may go past its 500 files (said in the log). */
  overCap?: true;
};

/** A file's text before a change (for undo). */
export type Before = { hash: string; text: string };

const PER_FOLDER = 500;
/** "Plain scalars only": a bare value, or one quoted on one line (no block or folded values). */
const ONE_LINE_TYPES = new Set<string>([Scalar.PLAIN, Scalar.QUOTE_DOUBLE, Scalar.QUOTE_SINGLE]);
/** The header's room on top of the text. */
const FILE_MAX = MEMORY_TEXT_MAX + 2048;
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KNOWN = new Set(["name", "description", "type", "see", "status", "due", "from", "suggested"]);
const CHANGED = "Changed since you read it";

const hashOf = (raw: string) => createHash("sha256").update(raw).digest("hex").slice(0, 16);
const folderOf = (s: MemoryScope) => (s === "you" ? "you" : `projects/${s.projectId}`);
/** How the app names a file: yours under you/, a project's under its id. */
const shown = (path: string) => path.replace(/^projects\//, "");
const cantRead = (path: string): FileRead => ({
  ok: false,
  gone: false,
  problem: `${shown(path)} can't be read`,
});

/**
 * Who may see a file unless it says: a person file, ions only, wherever it is (final review, 2026-11-22); else a
 * project's chats; your preferences and references too; the rest ions only.
 */
export function defaultSee(scope: MemoryScope, type: MemoryType): MemorySee {
  if (type === "person") return "ions";
  if (scope !== "you") return "chats";
  return type === "preference" || type === "reference" ? "chats" : "ions";
}

/** A file name from a name: lowercase letters, digits and "-", at most 60. */
export function slugOf(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-/, "")
    .replace(/-$/, "");
  return s || "note";
}

/** The scope and slug of a path inside the folder; null for anything else (`../x.md`, an absolute path). */
function partsOf(path: string): { scope: MemoryScope; slug: string } | null {
  if (!MEMORY_PATH.test(path)) return null;
  const bits = path.slice(0, -3).split("/");
  const slug = bits.at(-1)!;
  return bits[0] === "you" ? { scope: "you", slug } : { scope: { projectId: bits[1]! }, slug };
}

/** A value written as it is, on one line of the header: no anchor, alias, tag, list, map or block. */
const plain = (n: unknown, src: string): n is Scalar =>
  isScalar(n) &&
  !n.anchor &&
  !n.tag &&
  ONE_LINE_TYPES.has(n.type ?? "") &&
  !src.slice(n.range?.[0] ?? 0, n.range?.[1] ?? src.length).includes("\n");

/** A key: a plain word, never a merge key. */
const plainKey = (n: unknown, src: string): n is Scalar<string> =>
  plain(n, src) && typeof n.value === "string" && n.value !== "<<";

/** The header's keys, if it's a map of plain values: no anchors, aliases, tags, merge keys or nested values. */
function plainMap(src: string): Record<string, string> | null {
  const doc = parseDocument(src, { merge: false, uniqueKeys: true, schema: "core", strict: true });
  if (doc.errors.length || !isMap(doc.contents)) return null;
  const map = doc.contents;
  if (map.anchor || map.tag) return null;
  const out: Record<string, string> = {};
  for (const { key, value } of map.items) {
    if (!plainKey(key, src) || (value !== null && !plain(value, src))) return null;
    out[key.value] = value?.value == null ? "" : String(value.value);
  }
  return out;
}

/** A file's header and text; null when it can't be read as a memory file. */
function parseMemory(
  raw: string,
  scope: MemoryScope,
): { header: MemoryHeader; extra: Record<string, string>; text: string } | null {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(raw.replace(/\r\n/g, "\n"));
  if (!m) return null;
  const keys = plainMap(m[1]!);
  if (!keys) return null;
  const type = (keys.type || "fact") as MemoryType;
  const known = Object.fromEntries(Object.entries(keys).filter(([k]) => KNOWN.has(k)));
  const parsed = MemoryHeaderSchema.safeParse({ type, see: defaultSee(scope, type), ...known });
  const text = m[2]!.replace(/^\n+/, "").trimEnd();
  if (!parsed.success || Buffer.byteLength(text) > MEMORY_TEXT_MAX) return null;
  const extra = Object.fromEntries(Object.entries(keys).filter(([k]) => !KNOWN.has(k)));
  return { header: parsed.data, extra, text };
}

/** The file's text: a YAML header of plain values (the known keys first), then the text. */
function serializeMemory(header: MemoryHeader, extra: Record<string, string>, text: string): string {
  const yaml = stringify({ ...header, ...extra }, { lineWidth: 0, defaultStringType: "PLAIN" });
  return `---\n${yaml}---\n\n${text.trimEnd()}\n`;
}

/** A real folder (not a link), or nothing there. */
function realDirOrNone(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** The file's absolute path, if every folder on the way is a real one (none a link out of the folder). */
function located(root: string, scope: MemoryScope, slug: string): string | null {
  const dirs = [root, join(root, scope === "you" ? "you" : "projects")];
  if (scope !== "you") dirs.push(join(root, "projects", scope.projectId));
  return dirs.every(realDirOrNone) ? join(root, folderOf(scope), `${slug}.md`) : null;
}

function readIn(root: string, path: string): FileRead {
  const parts = partsOf(path);
  if (!parts) return { ok: false, gone: false, problem: "Not a memory file" };
  const abs = located(root, parts.scope, parts.slug);
  if (!abs) return cantRead(path);
  try {
    lstatSync(abs);
  } catch {
    return { ok: false, gone: true, problem: `${shown(path)} isn't there` };
  }
  // Not following a link, not blocking on a pipe, and not reading more than a memory file can hold.
  const opened = openFile(abs, FILE_MAX);
  if (opened?.kind !== "file" || opened.text === null) return cantRead(path);
  const parsed = parseMemory(opened.text, parts.scope);
  if (!parsed) return cantRead(path);
  return { ok: true, file: { path, ...parts, ...parsed, hash: hashOf(opened.text) } };
}

/** The folder a write goes to, made if it isn't there (only you can open it). */
function folderFor(root: string, scope: MemoryScope): string {
  if (scope !== "you" && !PROJECT_ID.test(scope.projectId)) throw new UserError("Unknown project");
  if (!located(root, scope, "x")) throw new UserError("ion can't write there");
  const dir = join(root, folderOf(scope));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function mdIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".md") && !n.startsWith("."));
  } catch {
    return [];
  }
}

/** A slug for a new file: its name's, or with -2, -3… when that's taken. */
function freeSlug(dir: string, name: string, overCap?: true): string {
  const base = slugOf(name);
  const taken = new Set(mdIn(dir).map((n) => n.slice(0, -3)));
  if (taken.size >= PER_FOLDER && !overCap)
    throw new UserError(`A memory folder holds ${PER_FOLDER} files at most`);
  for (let i = 1; ; i++) {
    const tail = i === 1 ? "" : `-${i}`;
    const slug = base.slice(0, 60 - tail.length).replace(/-$/, "") + tail;
    if (!taken.has(slug)) return slug;
  }
}

/** The file there now (for undo and the hash check), or nothing; refused when it can't be read or isn't `expectHash`. */
function current(root: string, path: string, expectHash: string | undefined): MemoryFile | null {
  const now = readIn(root, path);
  if (!now.ok && !now.gone) throw new UserError(now.problem);
  const file = now.ok ? now.file : null;
  if (file?.hash !== expectHash) throw new UserError(CHANGED);
  return file;
}

/** The text and header to write, checked. */
function checked(w: FileWrite): { text: string; header: MemoryHeader } {
  if (w.slug !== undefined && !MEMORY_SLUG.test(w.slug)) throw new UserError("Not a memory file");
  const text = w.text.trim();
  if (!text) throw new UserError("A memory can't be empty");
  if (Buffer.byteLength(text) > MEMORY_TEXT_MAX)
    throw new UserError("A memory file holds 8 KB of text at most");
  const parsed = MemoryHeaderSchema.safeParse({ see: defaultSee(w.scope, w.header.type), ...w.header });
  if (!parsed.success) throw new UserError(`That header won't do: ${parsed.error.issues[0]?.path.join(".")}`);
  return { text, header: parsed.data };
}

function writeIn(root: string, w: FileWrite): { file: MemoryFile; before?: Before } {
  const { text, header } = checked(w);
  const dir = folderFor(root, w.scope);
  const slug = w.slug ?? freeSlug(dir, header.name, w.overCap);
  const path = `${folderOf(w.scope)}/${slug}.md`;
  const was = current(root, path, w.slug === undefined ? undefined : w.expectHash);
  const extra = was?.extra ?? {};
  const raw = serializeMemory(header, extra, text);
  const tmp = join(dir, `.${slug}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, raw, { mode: 0o600, flag: "wx" });
  try {
    // Checked again just before it goes in: an edit of yours in between isn't written over.
    current(root, path, was?.hash);
    renameSync(tmp, join(dir, `${slug}.md`));
  } finally {
    rmSync(tmp, { force: true });
  }
  const file = { path, scope: w.scope, slug, header, extra, text, hash: hashOf(raw) };
  return was ? { file, before: { hash: was.hash, text: was.text } } : { file };
}

/** Deletes a file (a broken one too; with `expectHash`, only as it was read); what it was, if it could be read. */
function removeIn(root: string, path: string, expectHash?: string): Before | null {
  const parts = partsOf(path);
  const abs = parts && located(root, parts.scope, parts.slug);
  if (!abs) throw new UserError("Not a memory file");
  const now = readIn(root, path);
  if (expectHash !== undefined && (!now.ok || now.file.hash !== expectHash)) throw new UserError(CHANGED);
  rmSync(abs, { force: true });
  return now.ok ? { hash: now.file.hash, text: now.file.text } : null;
}

/** Every .md file's path in the folder (not following links to folders), well named or not. */
function allMd(root: string): string[] {
  const out = mdIn(join(root, "you")).map((n) => `you/${n}`);
  const projects = realDirOrNone(join(root, "projects")) ? safeDirs(join(root, "projects")) : [];
  for (const p of projects) out.push(...mdIn(join(root, "projects", p)).map((n) => `projects/${p}/${n}`));
  return out;
}

/** Every memory file's path in the folder. */
const listIn = (root: string) => allMd(root).filter((p) => MEMORY_PATH.test(p));

/** A line for each .md file ion can't take for a memory file by its name (task review, 2026-11-22). */
const misnamedIn = (root: string) =>
  allMd(root)
    .filter((p) => !MEMORY_PATH.test(p))
    .map((p) => `${shown(p)}: name must be lowercase-with-dashes.md`);

/**
 * The memory folder on disk: `you/<slug>.md` and `projects/<id>/<slug>.md`, read without following links, written
 * whole (a new file renamed into place) and only over the version the writer read.
 */
export function memoryFolder(root: string) {
  return {
    root,
    read: (path: string) => readIn(root, path),
    write: (w: FileWrite) => writeIn(root, w),
    remove: (path: string, expectHash?: string) => removeIn(root, path, expectHash),
    list: () => listIn(root),
    misnamed: () => misnamedIn(root),
  };
}

/** The real folders in a folder (links left out). */
function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && PROJECT_ID.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export type MemoryFolder = ReturnType<typeof memoryFolder>;
