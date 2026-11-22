import { mkdirSync, watch } from "node:fs";
import { basename, sep } from "node:path";
import { MEMORY_PATH } from "@ion/schema";
import type { MemoryFiles } from "./index.js";

/** How long after it starts the watch looks over the whole folder once. */
const START_MS = 1000;

/**
 * Watches the memory folder, so what you change in an editor is indexed and logged as yours. Changes are gathered
 * for `debounceMs` (an editor's save is often a few events), then each changed file is synced; a change ion can't
 * place (a folder, or no name) syncs the whole folder; so does one look a second after it starts. Returns a stop.
 */
export function watchMemory(files: MemoryFiles, o: { debounceMs?: number } = {}): () => void {
  mkdirSync(files.root, { recursive: true, mode: 0o700 });
  const pending = new Set<string>();
  let all = false;
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    const paths = [...pending];
    const whole = all;
    pending.clear();
    all = false;
    try {
      if (whole) files.reindex();
      else for (const p of paths) files.sync(p);
    } catch (e) {
      console.warn(`Memory: ${(e as Error).message}`);
    }
  };
  const noted = (name: string | null) => {
    const path = name?.split(sep).join("/");
    // ion's own half-written files (.<slug>…tmp) are its business.
    if (path && basename(path).startsWith(".")) return;
    if (path && MEMORY_PATH.test(path)) pending.add(path);
    else all = true;
    timer ??= setTimeout(flush, o.debounceMs ?? 300);
  };
  const w = watch(files.root, { recursive: true, persistent: false }, (_e, name) => noted(name));
  w.on("error", (e) => console.warn(`Memory: can't watch the folder (${e.message})`));
  // The OS starts watching a moment later: what changed in between (or since ion's start) is caught once, then.
  all = true;
  timer = setTimeout(flush, Math.max(o.debounceMs ?? 300, START_MS));
  return () => {
    w.close();
    if (timer) clearTimeout(timer);
  };
}
