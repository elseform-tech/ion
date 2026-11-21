import type { NeedInfo } from "@ion/schema";
import { describe, expect, it, vi } from "vitest";
import { createSame, parseSame } from "./same.js";

const waiting = [{ needId: "n1", summary: "Use the QA account?" } as NeedInfo];
const q = { question: "Use the QA account for staging?", choices: [{ label: "Yes", consequence: "x" }] };

// Plan 09: is a new question in an ion thread the same as one already waiting?
describe("same", () => {
  it("names a waiting question only when the whole answer is its JSON for one of them", () => {
    expect(parseSame('{"needId":"n1"}', waiting)).toBe("n1");
    expect(parseSame('{"needId":"n9"}', waiting)).toBeNull();
    expect(parseSame('{"none":true}', waiting)).toBeNull();
    expect(parseSame("yes, n1", waiting)).toBeNull();
  });

  it("asks the quick model with the questions as data, and says no when it fails", async () => {
    const run = vi.fn(async () => '{"needId":"n1"}');
    expect(await createSame(run)(q, waiting)).toBe("n1");
    expect(run.mock.calls[0]![0]).toContain("<ion-data");
    expect(await createSame(async () => Promise.reject(new Error("down")))(q, waiting)).toBeNull();
  });

  // Tour, 2026-11-21: a quick model that never answered held the question forever.
  it("says no when the quick model never answers", async () => {
    expect(await createSame(() => new Promise<string>(() => {}), 20)(q, waiting)).toBeNull();
  });
});
