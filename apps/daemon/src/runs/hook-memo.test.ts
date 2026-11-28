import { describe, expect, it } from "vitest";
import { HookMemo } from "./hook-memo.js";

// Security review, 2026-11-28 (hooks fix, I3): what your hooks said was kept 5 minutes from when they were asked, so a
// call that never reached its next check point left an answer a later identical call got, minutes old. It's kept
// 30 s from when it arrives.
describe("what your hooks said of a call", () => {
  const run = { chatId: "c", runId: "r" };
  const call = (at: "gate" | "prompt") => ({ key: "k", at });

  it("is kept 30 s from when it arrives, however long the hooks took", async () => {
    let t = 0;
    const memo = new HookMemo<string>(() => t);
    let asked = 0;
    const ask = async () => {
      asked++;
      t += 60_000; // the hooks took a minute
      return "said";
    };
    await memo.once(run, call("gate"), ask);
    t += 29_000;
    await memo.once(run, call("prompt"), ask);
    expect(asked).toBe(1);
    await memo.once(run, { key: "k2", at: "gate" }, ask);
    t += 31_000;
    await memo.once(run, { key: "k2", at: "prompt" }, ask);
    expect(asked).toBe(3);
  });
});
