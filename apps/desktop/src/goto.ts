import type { ToolType } from "@ion/schema";
import { useCallback, useEffect, useState } from "react";
import type { SettingsPage } from "./settings/pages.js";

/** A row in Settings → Tools: which tab, and its name. */
export type ToolsAt = { kind: ToolType; name: string };
/** Where Settings opens from a link elsewhere: a row in Tools, Memory (your files, or your to-dos), or a page (Search). */
export type SettingsAt =
  | ToolsAt
  | { kind: "todos" }
  | { kind: "memory" }
  | { kind: "page"; page: SettingsPage };

const OPEN_SETTINGS = "ion:open-settings";

const openAt = (at: SettingsAt): void => {
  window.dispatchEvent(new CustomEvent<SettingsAt>(OPEN_SETTINGS, { detail: at }));
};

/** Opens Settings → Tools at a row, from anywhere in the window (a chat's "added" line). */
export const openTools = (at: ToolsAt): void => openAt(at);

/** Opens Settings → Memory at your to-dos (ion chief's count, a chat's "Added to your to-dos"). */
export const openTodos = (): void => openAt({ kind: "todos" });

/** Opens Settings → Memory at your files (a chat's suggested preference, kept there). */
export const openMemory = (): void => openAt({ kind: "memory" });

/** Opens Settings at a page (Search: Plan 21 Task 4). */
export const openSettings = (page: SettingsPage): void => openAt({ kind: "page", page });

/** Hears each "open Settings here" (the window does: it switches to Settings). */
function useOpenSettings(fn: (at: SettingsAt) => void): void {
  useEffect(() => {
    const heard = (e: Event) => fn((e as CustomEvent<SettingsAt>).detail);
    window.addEventListener(OPEN_SETTINGS, heard);
    return () => window.removeEventListener(OPEN_SETTINGS, heard);
  }, [fn]);
}

/** A key for where Settings opened (a new place opens it anew). */
function atKey(at: SettingsAt | null): string {
  if (!at) return "settings";
  if ("page" in at) return `page:${at.page}`;
  return "name" in at ? `${at.kind}:${at.name}` : at.kind;
}

/**
 * Where a link opened Settings, and a key for it: hearing one switches the window to Settings (`go`); leaving Settings
 * forgets it, so Settings opens as usual next time. Each link gets a new key (review of Plan 21 Task 4: Search → the
 * same page twice did nothing, since Settings reads where to open only when it mounts).
 */
export function useSettingsAt<M extends string>(mode: M, go: (m: M) => void): [SettingsAt | null, string] {
  const [state, setState] = useState<{ at: SettingsAt | null; n: number }>({ at: null, n: 0 });
  useOpenSettings(
    useCallback(
      (a: SettingsAt) => {
        setState((s) => ({ at: a, n: s.n + 1 }));
        go("settings" as M);
      },
      [go],
    ),
  );
  useEffect(() => {
    if (mode !== "settings") setState((s) => (s.at ? { at: null, n: s.n } : s));
  }, [mode]);
  return [state.at, `${atKey(state.at)}#${state.n}`];
}
