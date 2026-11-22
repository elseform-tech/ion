import { EV, type MemoryBy, type MemoryScope } from "@ion/schema";
import type { EventStore } from "../store/index.js";
import type { MemoryFiles } from "./index.js";

/** A memory note from before memory was files. */
type Note = {
  memoryId: string;
  scope: MemoryScope;
  text: string;
  source: "you" | { chatId: string; runId: string };
};

/** The notes still kept (written, not forgotten), oldest first. */
function liveNotes(store: EventStore): Note[] {
  const notes = new Map<string, Note>();
  for (const e of store.read({ types: [EV.memoryWritten, EV.memoryForgotten], limit: 1_000_000 })) {
    const d = e.data as Partial<Note> & { path?: string };
    if (typeof d.memoryId !== "string" || d.path !== undefined) continue;
    if (e.type === EV.memoryForgotten) notes.delete(d.memoryId);
    else notes.set(d.memoryId, d as Note);
  }
  return [...notes.values()];
}

/** The notes already moved: logged with `from:` (even if the file was deleted since). */
function movedNotes(store: EventStore): Set<string> {
  const ids = new Set<string>();
  for (const e of store.read({ types: [EV.memoryWritten], limit: 1_000_000 })) {
    const from = (e.data as { header?: { from?: string } }).header?.from;
    if (from) ids.add(from);
  }
  return ids;
}

/** The files on disk that came from a note (a move stopped before its event was logged). */
function filesFromNotes(files: MemoryFiles): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of files.paths()) {
    const r = files.read(path);
    if (r.ok && r.file.header.from) out.set(r.file.header.from, path);
  }
  return out;
}

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PER_FOLDER = 500;

/** Who wrote a note, as a file's author: an ion's note was kept as its chat ("ion:<id>"). */
function authorOf(source: Note["source"]): MemoryBy {
  if (source === "you") return source;
  return source.chatId.startsWith("ion:") ? { ion: source.chatId.slice(4) } : source;
}

/** Moves one note (a file of its own), or says in one line why it stays for now. */
function moveOne(files: MemoryFiles, n: Note): boolean {
  if (n.scope !== "you" && !PROJECT_ID.test(n.scope.projectId)) {
    console.warn(
      `Memory: an old note (${n.memoryId}) is for a project ion can't name (${n.scope.projectId}); left as it was`,
    );
    return false;
  }
  try {
    const see = n.scope === "you" ? "ions" : "chats";
    files.note(n.scope, n.text, authorOf(n.source), { from: n.memoryId, see, overCap: true });
    return true;
  } catch (e) {
    console.warn(
      `Memory: an old note (${n.memoryId}) couldn't move to a file (${(e as Error).message}); trying again next start`,
    );
    return false;
  }
}

/** Says once for each folder the move took past its 500 files (only the move may). */
function sayOverCap(files: MemoryFiles): void {
  const counts = new Map<string, number>();
  for (const p of files.paths()) {
    const folder = p.slice(0, p.lastIndexOf("/"));
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  for (const [folder, n] of counts)
    if (n > PER_FOLDER)
      console.warn(`Memory: ${folder} holds ${n} files after the move (${PER_FOLDER} at most for new ones)`);
}

/**
 * Moves each memory note from before memory was files to its own file, once: yours to you/ (a fact, for ions), a
 * project's to its folder (a fact, for its chats). Each file keeps its note's id (`from:`), so a restart in the middle
 * never moves one twice. A note that can't move is said in one line and stays (tried again at the next start); it
 * never stops the others, or ion's start. Returns how many it moved.
 */
export function moveNotes(files: MemoryFiles, store: EventStore): number {
  const notes = liveNotes(store);
  if (!notes.length) return 0;
  const moved = movedNotes(store);
  const onDisk = filesFromNotes(files);
  let count = 0;
  for (const n of notes.filter((x) => !moved.has(x.memoryId))) {
    const path = onDisk.get(n.memoryId);
    // Written before ion stopped, not logged yet: logged now, as the note's.
    if (path && !files.indexed(path)) files.sync(path, authorOf(n.source));
    if (!path && moveOne(files, n)) count++;
  }
  if (count) sayOverCap(files);
  return count;
}
