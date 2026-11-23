import { EV, type IonEvent } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { hookEventOf } from "./catalog.js";

const ev = (chatId: string | null, type: string, data: Record<string, unknown>) =>
  ({
    v: 1,
    id: "e1",
    chatId,
    runId: "r1",
    seq: 1,
    ts: "2026-11-22T10:00:00.000Z",
    origin: "daemon",
    type,
    data,
  }) as IonEvent;

// Re-review, 2026-11-22: an ion's turn ending (kept for its agent's usage, with no chat) ran your "A chat finishes"
// hook. Only a chat's run is a chat finishing or starting.
describe("hookEventOf", () => {
  it("a run with no chat (an ion's turn, the judge) isn't a chat's", () => {
    expect(hookEventOf(ev(null, EV.runFinished, { status: "done", harness: "grok-build" }))).toBeNull();
    expect(hookEventOf(ev(null, EV.runStarted, { harness: "grok-build" }))).toBeNull();
    expect(hookEventOf(ev("ion:chief", EV.runFinished, { status: "done" }))).toBeNull();
    expect(hookEventOf(ev("c1", EV.runFinished, { status: "done" }))).not.toBeNull();
  });
});
