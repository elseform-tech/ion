/** What a key press carries that a hotkey looks at. */
type Press = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean };

/** ⌘ on macOS, Ctrl elsewhere. */
const mod = (e: Press) => e.metaKey || e.ctrlKey;
const enter = (e: Press) => e.key === "Enter";

/**
 * Every hotkey the app handles, in the order Settings → Shortcuts lists them: its name there, the keys it shows
 * (⌘ is Ctrl off macOS), and whether a key press is it. The handlers ask `hit`, so the page and the app agree.
 */
export const HOTKEYS = [
  {
    id: "sidebar",
    name: "Hide sidebar",
    keys: ["⌘", "B"],
    match: (e: Press) => mod(e) && e.key.toLowerCase() === "b",
  },
  // Plan 21 Task 4: the lab's Search, so a page tucked under More is one search away.
  {
    id: "search",
    name: "Search",
    keys: ["⌘", "K"],
    match: (e: Press) => mod(e) && e.key.toLowerCase() === "k",
  },
  { id: "effort", name: "Next effort", keys: ["⌘", "."], match: (e: Press) => mod(e) && e.key === "." },
  { id: "send", name: "Send", keys: ["↵"], match: (e: Press) => enter(e) && !e.shiftKey && !mod(e) },
  {
    id: "queue",
    name: "Queue while it works",
    keys: ["↵"],
    match: (e: Press) => enter(e) && !e.shiftKey && !mod(e),
  },
  { id: "now", name: "Send now", keys: ["⌘", "↵"], match: (e: Press) => enter(e) && !e.shiftKey && mod(e) },
  { id: "newline", name: "New line", keys: ["⇧", "↵"], match: (e: Press) => enter(e) && e.shiftKey },
  { id: "stop", name: "Stop", keys: ["esc", "esc"], match: (e: Press) => e.key === "Escape" },
] as const;

type HotkeyId = (typeof HOTKEYS)[number]["id"];

/** Whether a key press is this hotkey (for Stop: one of its two presses). */
export function hit(id: HotkeyId, e: Press): boolean {
  return HOTKEYS.find((k) => k.id === id)!.match(e);
}
