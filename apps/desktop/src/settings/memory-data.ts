import type { IonClient } from "@ion/client/browser";
import { EV, type IonInfo, type MemoryInfo, type MemoryType } from "@ion/schema";
import { useCallback, useEffect, useState } from "react";

export type MemoryData = {
  files: MemoryInfo[];
  /** The memory folder, and each file in it that can't be read. */
  folder: { path: string; problems: string[] } | null;
  reload: () => void;
};

/** What changes the Memory page: a file written or forgotten (by you, a chat, an ion, or in your editor). */
const CHANGES = new Set<string>([EV.memoryWritten, EV.memoryForgotten]);

/** Hears ion's events from now on while mounted; `fn` for each. */
function useEvents(client: IonClient, fn: (type: string) => void): void {
  useEffect(() => {
    let stop: (() => void) | undefined;
    let gone = false;
    void client
      .subscribe({ fromNow: true }, (e) => {
        if (!gone) fn(e.type);
      })
      .then(
        (s) => {
          if (gone) s();
          else stop = s;
        },
        () => {},
      );
    return () => {
      gone = true;
      stop?.();
    };
  }, [client, fn]);
}

/** Every memory file (yours and each project's) and the folder, read again when one changes. */
export function useMemory(client: IonClient): MemoryData {
  const [files, setFiles] = useState<MemoryInfo[]>([]);
  const [folder, setFolder] = useState<MemoryData["folder"]>(null);
  const reload = useCallback(() => {
    const quiet = () => {};
    void client.call("memory.list", {}).then(setFiles, quiet);
    void client.call("memory.folder", {}).then(setFolder, quiet);
  }, [client]);
  useEffect(reload, [reload]);
  useEvents(
    client,
    useCallback((type: string) => CHANGES.has(type) && reload(), [reload]),
  );
  return { files, folder, reload };
}

/** How long typing pauses before a search goes out. */
const SEARCH_WAIT_MS = 150;

/**
 * The index's best matches for some words in one scope ("you" or a project's id), asked once typing pauses (null: no
 * words). The daemon keeps that scope's best 20 (task review, 2026-11-22).
 */
export function useSearch(
  client: IonClient,
  q: string,
  scope: string,
  files: MemoryInfo[],
): MemoryInfo[] | null {
  const [found, setFound] = useState<MemoryInfo[] | null>(null);
  const words = q.trim();
  useEffect(() => {
    if (!words) {
      setFound(null);
      return;
    }
    let gone = false;
    const timer = setTimeout(() => {
      void client.call("memory.search", { q: words, scope }).then(
        (r) => !gone && setFound(r),
        () => !gone && setFound([]),
      );
    }, SEARCH_WAIT_MS);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [client, words, scope, files]);
  return found;
}

/** Who changed it last: you, a chat (by its title), or an ion (by its name). */
export function whoOf(m: { source: string; sourceTitle?: string }, ions: IonInfo[]): string {
  if (m.source === "you") return "You";
  if (m.source.startsWith("ion:")) {
    const id = m.source.slice(4);
    // ion chief's name is the wordmark, "ion": said in full here, so it isn't read as ion itself (tour, 2026-11-22).
    if (id === "chief") return "ion chief";
    return ions.find((i) => i.ionId === id)?.name ?? id;
  }
  return m.sourceTitle ?? "A chat";
}

/** Whose a file is: "you", or a project's id. */
export const scopeOf = (m: { scope: string }) =>
  m.scope === "you" ? "you" : m.scope.slice("project:".length);

/** Your file, not a to-do and not a chat's suggestion: you choose whether chats see it (as the lab). */
export const sharable = (m: MemoryInfo) => m.scope === "you" && !m.suggested && m.type !== "todo";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/** A to-do's date in words: Overdue, Due today, Due tomorrow, Due Friday (this week), else Due 3 Dec. */
export function dueOf(due: string, now = new Date()): { text: string; late: boolean } {
  const [y, m, d] = due.split("-").map(Number) as [number, number, number];
  const day = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((day.getTime() - today.getTime()) / DAY_MS);
  if (days < 0) return { text: "Overdue", late: true };
  if (days === 0) return { text: "Due today", late: false };
  if (days === 1) return { text: "Due tomorrow", late: false };
  if (days < 7) return { text: `Due ${WEEKDAYS[day.getDay()]}`, late: false };
  return { text: `Due ${day.getDate()} ${MONTHS[day.getMonth()]}`, late: false };
}

/** Each type's name, for its icon's hover. */
export const TYPE_NAME: Record<MemoryType, string> = {
  preference: "Preference",
  fact: "Fact",
  person: "Person",
  todo: "To-do",
  reference: "Reference",
};

/** How many to-dos are open (yours and every project's), kept live. */
export function useOpenTodos(client: IonClient): number {
  const [n, setN] = useState(0);
  const read = useCallback(() => {
    void client.call("memory.list", { type: "todo", open: true }).then(
      (r) => setN(r.length),
      () => {},
    );
  }, [client]);
  useEffect(read, [read]);
  useEvents(
    client,
    useCallback((type: string) => CHANGES.has(type) && read(), [read]),
  );
  return n;
}
