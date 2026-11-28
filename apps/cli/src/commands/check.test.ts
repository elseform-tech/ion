import type { AgentChecksInfo } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { checksText } from "./harnesses.js";

// Plan 21 Task 5, 2026-11-28: `ion agents check` says the nightly check in a few plain lines.
describe("ion agents check", () => {
  it("says each agent's part, the last checks in a line, and why each failed one failed", () => {
    const info: AgentChecksInfo = {
      nightly: true,
      running: false,
      window: "22:00–08:00",
      agents: [
        { agent: "opencode", label: "opencode", included: true, why: null, picked: false, cost: "Free" },
        {
          agent: "grok-build",
          label: "Grok Build",
          included: false,
          why: "Only if you pick it",
          picked: false,
          cost: "A little of your plan",
        },
      ],
      last: [
        {
          agent: "opencode",
          label: "opencode",
          at: new Date(2026, 10, 28, 2).toISOString(),
          checks: [
            { name: "Starts", ok: true },
            { name: "Answers", ok: false, note: "Said nothing" },
            { name: "Gate", ok: false },
          ],
        },
      ],
    };
    expect(checksText(info, new Date(2026, 10, 28, 9))).toBe(
      [
        "Each night, 22:00–08:00",
        "opencode  Included  Free",
        "Grok Build  Only if you pick it  A little of your plan",
        "opencode: 2 checks failed",
        "  opencode: Answers (Said nothing)",
        "  opencode: Gate",
      ].join("\n"),
    );
    const fine = {
      ...info,
      nightly: false,
      last: [{ ...info.last[0]!, checks: [{ name: "Starts", ok: true }] }],
    };
    expect(checksText(fine, new Date(2026, 10, 28, 9)).split("\n")).toEqual([
      "Each night: off",
      "opencode  Included  Free",
      "Grok Build  Only if you pick it  A little of your plan",
      "Checked last night: all fine",
    ]);
  });
});
