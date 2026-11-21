import type { ToolType } from "@ion/schema";
import { useCallback, useEffect, useState } from "react";

/** A row in Settings → Tools: which tab, and its name. */
export type ToolsAt = { kind: ToolType; name: string };

const OPEN_TOOLS = "ion:open-tools";

/** Opens Settings → Tools at a row, from anywhere in the window (a chat's "added" line). */
export const openTools = (at: ToolsAt): void => {
  window.dispatchEvent(new CustomEvent<ToolsAt>(OPEN_TOOLS, { detail: at }));
};

/** Hears each "open Settings → Tools at this row" (the window does: it switches to Settings). */
function useOpenTools(fn: (at: ToolsAt) => void): void {
  useEffect(() => {
    const heard = (e: Event) => fn((e as CustomEvent<ToolsAt>).detail);
    window.addEventListener(OPEN_TOOLS, heard);
    return () => window.removeEventListener(OPEN_TOOLS, heard);
  }, [fn]);
}

/**
 * The row a chat's "added" line opened: hearing one switches the window to Settings (`go`); leaving Settings forgets
 * it, so Settings opens as usual next time.
 */
export function useToolsAt<M extends string>(mode: M, go: (m: M) => void): ToolsAt | null {
  const [at, setAt] = useState<ToolsAt | null>(null);
  useOpenTools(
    useCallback(
      (a: ToolsAt) => {
        setAt(a);
        go("settings" as M);
      },
      [go],
    ),
  );
  useEffect(() => {
    if (mode !== "settings") setAt(null);
  }, [mode]);
  return at;
}
