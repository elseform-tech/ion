import { openPath, openUrl } from "@tauri-apps/plugin-opener";

const inTauri = () => "__TAURI_INTERNALS__" in window;

/** What the app says when the system wouldn't open a file or page. */
export const CANT_OPEN = "Couldn't open it";

/**
 * Opens a file in your editor (the system's app for it). The window may open only ion's mcp.json (its capability).
 * Outside the app (a browser, for the tour) there's no opener: the path is copied instead.
 */
export async function openFile(path: string): Promise<"opened" | "copied" | "failed"> {
  try {
    if (inTauri()) {
      await openPath(path);
      return "opened";
    }
    await navigator.clipboard.writeText(path);
    return "copied";
  } catch {
    return "failed";
  }
}

/** Opens a sign-in page in your browser: https only (the window's capability allows nothing else). */
export async function openLink(url: string): Promise<void> {
  if (!url.startsWith("https://")) throw new Error(CANT_OPEN);
  if (inTauri()) return openUrl(url);
  window.open(url, "_blank", "noopener");
}
