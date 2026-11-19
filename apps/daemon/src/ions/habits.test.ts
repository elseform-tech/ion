import { describe, expect, it } from "vitest";
import { habits, sameKey, whenFor } from "./habits.js";

// November 2026: the 6th and 13th are Fridays; "now" is Thursday the 19th.
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);
const now = at(19, 12);
const said = (d: Date, text: string) => ({ at: d, text, title: null, chatId: null });
const chat = (d: Date, title: string, chatId: string) => ({
  at: d,
  text: `${title}, please`,
  title,
  chatId,
});

// Plan 11: the same thing on 3 different days becomes a routine suggestion.
describe("the same thing", () => {
  it("is the same words, case, punctuation and dates aside", () => {
    expect(sameKey("Summarize this week's PRs.")).toBe("summarize this week s prs");
    expect(sameKey("PR summary for 7 Nov")).toBe(sameKey("pr summary for Nov 14th!"));
    expect(sameKey("PR summary 2026-11-07")).toBe(sameKey("PR summary 11/14"));
    expect(sameKey("PR summary")).not.toBe(sameKey("PR review"));
  });
});

describe("when it would run", () => {
  it("is the one weekday they were all on, at the median time to the half hour", () => {
    expect(whenFor([new Date(2026, 9, 30, 17, 2), at(6, 16, 50), at(13, 17, 20)])).toBe("fri 17:00");
    expect(whenFor([new Date(2026, 9, 30, 17, 10), at(6, 17, 20), at(13, 18, 0)])).toBe("fri 17:30");
  });
  it("is daily when they were on different days", () => {
    expect(whenFor([at(16, 9, 5), at(17, 8, 40), at(18, 9, 20), at(19, 10, 0)])).toBe("daily 09:00");
  });
  it("never rounds past the day's end", () => {
    expect(whenFor([at(16, 23, 50), at(17, 23, 55), at(18, 23, 59)])).toBe("daily 23:30");
  });
});

describe("habits", () => {
  it("finds what you asked for on 3 different days, with the dates newest first", () => {
    const h = habits(
      [
        said(at(6, 17), "Summarize this week's PRs"),
        said(at(13, 17), "summarize this week's PRs."),
        chat(at(18, 17), "Summarize this week's PRs", "c1"),
      ],
      now,
    );
    expect(h).toEqual([
      {
        key: "summarize this week s prs",
        name: "Summarize this week's PRs",
        text: "Summarize this week's PRs, please",
        when: "daily 17:00",
        dates: [at(18, 17), at(13, 17), at(6, 17)].map((d) => d.toISOString()),
      },
    ]);
  });

  it("needs 3 different days: twice the same day counts once", () => {
    const e2e = "Run the e2e tests";
    expect(habits([said(at(7, 9), e2e), said(at(7, 15), e2e), said(at(8, 9), e2e)], now)).toEqual([]);
  });

  it("looks back four weeks only, and skips a single word", () => {
    const e2e = "Run the e2e tests";
    const old = [said(new Date(2026, 9, 1, 9), e2e), said(at(16, 9), e2e), said(at(17, 9), e2e)];
    expect(habits(old, now)).toEqual([]);
    const one = [said(at(16, 9), "status"), said(at(17, 9), "Status?"), said(at(18, 9), "status")];
    expect(habits(one, now)).toEqual([]);
  });

  it("names it from your words, cut short", () => {
    const long = "Go through every open pull request in the repo and write me a short summary of each one";
    const [h] = habits([said(at(16, 9), long), said(at(17, 9), long), said(at(18, 9), long)], now);
    expect(h!.name.length).toBeLessThanOrEqual(60);
    expect(h!.name.endsWith("…")).toBe(true);
    expect(h!.text).toBe(long);
  });
});
