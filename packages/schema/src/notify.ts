import type { NotifyLevel } from "./api.js";

/** Notifications as they start (your config's defaults; the app shows Notifications once you change them). */
export const NOTIFY_DEFAULTS = {
  briefing: { on: true, at: "08:30" },
  quiet: { on: true, from: "22:00", to: "08:00" },
  level: "needs" as NotifyLevel,
} as const;
