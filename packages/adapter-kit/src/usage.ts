import type { UsageWindow } from "@ion/schema";

/** A window's name from its length: "5 h", "day", "week", "30 d". */
function windowName(mins: number): string {
  if (mins === 1440) return "day";
  if (mins === 10_080) return "week";
  return mins < 1440 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`;
}

/**
 * One of an agent's rate-limit windows in ion's terms, from its length (minutes), how much is used (percent) and
 * its reset (unix seconds); null when what the agent said isn't usable.
 */
export function usageWindow(mins: unknown, usedPercent: unknown, resetsAtS: unknown): UsageWindow | null {
  if (
    typeof mins !== "number" ||
    mins <= 0 ||
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent)
  )
    return null;
  const resetsAt =
    typeof resetsAtS === "number" && resetsAtS > 0 ? new Date(resetsAtS * 1000).toISOString() : null;
  return { name: windowName(mins), usedPercent: Math.min(100, Math.max(0, usedPercent)), resetsAt };
}
