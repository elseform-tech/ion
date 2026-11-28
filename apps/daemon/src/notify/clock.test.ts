import { describe, expect, it } from "vitest";
import { quietNight } from "./clock.js";

// Plan 21 final review (2026-11-28): the agents' nightly check and a free agent's judge check each had their own
// "quiet night" rule. One rule now: in quiet hours (else 01:00–06:00) for an hour, nothing in ion for 30 minutes.
describe("quietNight", () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 28, h, m);
  const q = { on: true, from: "22:00", to: "08:00" };
  it("an hour into the night's hours, after 30 quiet minutes", () => {
    expect(quietNight(q, at(22, 30), at(21))).toBeNull();
    expect(quietNight(q, at(23, 30), at(23, 10))).toBeNull();
    expect(quietNight(q, at(23, 30), at(22, 50))).not.toBeNull();
    expect(quietNight({ ...q, on: false }, at(3), at(1))).not.toBeNull();
    expect(quietNight({ ...q, on: false }, at(1, 30), null)).toBeNull();
    expect(quietNight({ ...q, on: false }, at(7), null)).toBeNull();
  });
});
