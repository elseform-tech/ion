import {
  Bell,
  Blocks,
  Keyboard,
  type LucideIcon,
  NotebookText,
  Orbit,
  Plug,
  SlidersHorizontal,
} from "@ion/design-system";

export type SettingsPage = "general" | "agents" | "ions" | "memory" | "tools" | "notifications" | "shortcuts";

/**
 * Settings' pages, in the sidebar's order (Plan 21 Task 4, the user, 2026-11-24: General, Agents and Memory first; the
 * rest under one More until used). Search lists every one, so a tucked page is never out of reach.
 */
export const SETTINGS_PAGES: { id: SettingsPage; label: string; icon: LucideIcon; tucked?: true }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "agents", label: "Agents", icon: Plug },
  { id: "memory", label: "Memory", icon: NotebookText },
  { id: "ions", label: "Ions", icon: Orbit, tucked: true },
  { id: "tools", label: "Tools", icon: Blocks, tucked: true },
  { id: "notifications", label: "Notifications", icon: Bell, tucked: true },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard, tucked: true },
];
