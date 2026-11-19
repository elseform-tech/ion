import { describe, expect, it } from "vitest";
import { nextRun, parseWhen, timeLabel, whenLabel } from "./when.js";

describe("timeLabel", () => {
  const now = new Date(2026, 10, 19, 8, 0); // a Thursday
  it("says a time today, tomorrow, this week, or later by its date", () => {
    expect(timeLabel(new Date(2026, 10, 19, 9, 0), now)).toBe("9:00");
    expect(timeLabel(new Date(2026, 10, 20, 17, 30), now)).toBe("Tomorrow 17:30");
    expect(timeLabel(new Date(2026, 10, 23, 9, 0), now)).toBe("Mon 9:00");
    expect(timeLabel(new Date(2026, 10, 30, 9, 0), now)).toBe("Nov 30 9:00");
    expect(timeLabel(new Date(2026, 10, 18, 16, 5), now)).toBe("Yesterday 16:05");
  });
});

// Local times: a routine's schedule is the machine's own clock.
const at = ([y, mo, d]: [number, number, number], h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe("parseWhen", () => {
  it("reads each kind, and writes it back the one way", () => {
    expect(parseWhen("daily 9:00")).toEqual({ kind: "daily", hour: 9, minute: 0 });
    expect(parseWhen("weekdays 17:30")).toEqual({ kind: "weekdays", hour: 17, minute: 30 });
    expect(parseWhen("fri 08:05")).toEqual({ kind: "weekly", day: 5, hour: 8, minute: 5 });
    expect(parseWhen("sun 23:59")).toEqual({ kind: "weekly", day: 0, hour: 23, minute: 59 });
    expect(parseWhen("every 4h")).toEqual({ kind: "hours", every: 4 });
    expect(parseWhen("  Daily  09:00 ")).toEqual({ kind: "daily", hour: 9, minute: 0 });
  });

  it("refuses what isn't a schedule", () => {
    for (const bad of [
      "",
      "daily",
      "daily 24:00",
      "daily 9:60",
      "daily 9",
      "monday 9:00",
      "every 0h",
      "every 24h",
    ])
      expect(parseWhen(bad), bad).toBeNull();
    expect(parseWhen("every 1.5h")).toBeNull();
    expect(parseWhen("hourly")).toBeNull();
  });
});

describe("whenLabel", () => {
  it("says it plainly", () => {
    expect(whenLabel("daily 09:00")).toBe("Every day 9:00");
    expect(whenLabel("weekdays 17:30")).toBe("Weekdays 17:30");
    expect(whenLabel("fri 14:00")).toBe("Fridays 14:00");
    expect(whenLabel("every 1h")).toBe("Every hour");
    expect(whenLabel("every 6h")).toBe("Every 6 hours");
    expect(whenLabel("nonsense")).toBe("nonsense");
  });
});

describe("nextRun", () => {
  it("daily: later today, else tomorrow; never the same instant", () => {
    expect(nextRun("daily 09:00", at([2026, 11, 19], 8, 0))).toEqual(at([2026, 11, 19], 9, 0));
    expect(nextRun("daily 09:00", at([2026, 11, 19], 9, 0))).toEqual(at([2026, 11, 20], 9, 0));
    expect(nextRun("daily 09:00", at([2026, 11, 19], 21, 0))).toEqual(at([2026, 11, 20], 9, 0));
  });

  it("daily: across a month and a year", () => {
    expect(nextRun("daily 07:15", at([2026, 11, 30], 8))).toEqual(at([2026, 12, 1], 7, 15));
    expect(nextRun("daily 00:00", at([2026, 12, 31], 12))).toEqual(at([2027, 1, 1], 0, 0));
  });

  it("weekdays: skips Saturday and Sunday", () => {
    // 2026-11-20 is a Friday.
    expect(nextRun("weekdays 09:00", at([2026, 11, 20], 8))).toEqual(at([2026, 11, 20], 9));
    expect(nextRun("weekdays 09:00", at([2026, 11, 20], 10))).toEqual(at([2026, 11, 23], 9));
    expect(nextRun("weekdays 09:00", at([2026, 11, 21], 10))).toEqual(at([2026, 11, 23], 9));
  });

  it("one weekday: this week if it's still ahead, else next week", () => {
    // 2026-11-19 is a Thursday.
    expect(nextRun("thu 18:00", at([2026, 11, 19], 17))).toEqual(at([2026, 11, 19], 18));
    expect(nextRun("thu 18:00", at([2026, 11, 19], 18))).toEqual(at([2026, 11, 26], 18));
    expect(nextRun("mon 09:00", at([2026, 11, 19], 12))).toEqual(at([2026, 11, 23], 9));
    expect(nextRun("sun 09:00", at([2026, 11, 22], 8))).toEqual(at([2026, 11, 22], 9));
  });

  it("every N hours: on the hours counted from midnight", () => {
    expect(nextRun("every 4h", at([2026, 11, 19], 9, 30))).toEqual(at([2026, 11, 19], 12));
    expect(nextRun("every 4h", at([2026, 11, 19], 12))).toEqual(at([2026, 11, 19], 16));
    expect(nextRun("every 4h", at([2026, 11, 19], 22))).toEqual(at([2026, 11, 20], 0));
    expect(nextRun("every 1h", at([2026, 11, 19], 9, 59))).toEqual(at([2026, 11, 19], 10));
    // 5 doesn't divide a day: 0, 5, 10, 15, 20, then midnight again.
    expect(nextRun("every 5h", at([2026, 11, 19], 21))).toEqual(at([2026, 11, 20], 0));
  });

  it("ignores seconds: a slot is its minute", () => {
    const from = new Date(2026, 10, 19, 8, 59, 59, 500);
    expect(nextRun("daily 09:00", from)).toEqual(at([2026, 11, 19], 9));
  });

  it("throws on a schedule it can't read", () => {
    expect(() => nextRun("whenever", at([2026, 11, 19]))).toThrow(/schedule/);
  });

  it("walking it never repeats or goes back", () => {
    for (const when of ["daily 09:00", "weekdays 06:30", "wed 12:00", "every 3h", "every 7h"]) {
      let t = at([2026, 1, 1]);
      for (let i = 0; i < 400; i++) {
        const n = nextRun(when, t);
        expect(n.getTime(), when).toBeGreaterThan(t.getTime());
        t = n;
      }
    }
  });
});
