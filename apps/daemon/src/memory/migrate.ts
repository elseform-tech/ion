import { EV, type MemoryBy, type MemoryScope } from "@ion/schema";
import type { EventStore } from "../store/index.js";
import type { MemoryFiles } from "./index.js";

/** A memory note from before memory was files. */
type Note = { memoryId: string; scope: MemoryScope; text: string; source: MemoryBy };

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

/**
 * Moves each memory note from before memory was files to its own file, once: yours to you/ (a fact, for ions), a
 * project's to its folder (a fact, for its chats). Each file keeps its note's id (`from:`), so a restart in the middle
 * never moves one twice. Returns how many it moved.
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
    if (path && !files.indexed(path)) files.sync(path, n.source);
    if (path) continue;
    const see = n.scope === "you" ? "ions" : "chats";
    files.note(n.scope, n.text, n.source, { from: n.memoryId, see });
    count++;
  }
  return count;
}
