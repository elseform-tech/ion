import type { IonEvent } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { empty, reduce, type Timeline } from "./timeline.js";

let seq = 0;
const ev = (
  type: string,
  data: Record<string, unknown>,
  at = "2026-11-18T10:00:00.000Z",
  runId = "r1",
): IonEvent =>
  ({ v: 1, id: `e${++seq}`, chatId: "c1", runId, seq, ts: at, origin: "daemon", type, data }) as IonEvent;
const play = (...events: IonEvent[]): Timeline => events.reduce(reduce, empty());

describe("timeline", () => {
  it("shows your message, then the agent's streamed text as one message", () => {
    const t = play(
      ev("message.sent", { text: "Fix the tests" }),
      ev("message.delta", { text: "Look" }),
      ev("message.delta", { text: "ing." }),
      ev("message.completed", { text: "Looking." }),
    );
    expect(t.items).toEqual([
      { kind: "you", text: "Fix the tests" },
      { kind: "agent", text: "Looking.", done: true },
    ]);
  });

  // Review Focus 2: a long chat stays one item per message.
  it("folds 5,000 deltas into one message", () => {
    const events = Array.from({ length: 5000 }, () => ev("message.delta", { text: "x" }));
    const t = play(...events);
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ kind: "agent", text: "x".repeat(5000), done: false });
  });

  it("groups a run's tools under one 'worked' item, and ends with how long it took", () => {
    const t = play(
      ev("run.started", { harness: "fake" }, "2026-11-18T10:00:00.000Z"),
      ev("tool.started", { toolId: "t1", name: "Read", kind: "read", summary: "a.ts" }),
      ev("tool.finished", { toolId: "t1", ok: true, summary: null }),
      ev("tool.started", { toolId: "t2", name: "Bash", kind: "command", summary: "pnpm test" }),
      ev("tool.finished", { toolId: "t2", ok: false, summary: "Not allowed" }),
      ev("usage.reported", { costUsd: 0.0031 }),
      ev("run.finished", { status: "done" }, "2026-11-18T10:02:04.000Z"),
    );
    expect(t.items).toEqual([
      {
        kind: "work",
        runId: "r1",
        tools: [
          { name: "Read", summary: "a.ts", ok: true },
          { name: "Bash", summary: "pnpm test", ok: false },
        ],
      },
      { kind: "end", status: "done", seconds: 124, cost: 0.0031 },
    ]);
  });

  it("says what ion decided in Auto, and stays quiet for policy, Full access and the gate", () => {
    const t = play(
      ev("approval.requested", { requestId: "q1", toolId: "t", kind: "command", summary: "pnpm test" }),
      ev("approval.resolved", { requestId: "q1", decision: "allow", by: "ion", reason: "Runs the tests" }),
      ev("approval.resolved", {
        requestId: "g1",
        decision: "deny",
        by: "ion",
        reason: "Touches your secrets",
        summary: "cat ~/.ssh/id_rsa",
      }),
      ev("approval.resolved", { requestId: "q2", decision: "allow", by: "policy" }),
      ev("approval.resolved", { requestId: "q3", decision: "allow", by: "full" }),
      ev("approval.resolved", { requestId: "q4", decision: "allow", by: "gate" }),
    );
    expect(t.items).toEqual([
      { kind: "ion", tone: "allow", text: "Allowed by ion: pnpm test" },
      { kind: "ion", tone: "deny", text: "Denied by ion: cat ~/.ssh/id_rsa — Touches your secrets" },
    ]);
  });

  it("shows an agent's question, your answer, and ion's answer from a decision", () => {
    const choices = [
      { label: "Delete it", consequence: "build/ is removed" },
      { label: "Keep it", consequence: "Nothing changes" },
    ];
    const t = play(
      ev("need.raised", {
        needId: "n1",
        requestId: "a",
        kind: "ask",
        summary: "Delete build/?",
        detail: "2 GB",
        dedupeKey: "k",
        choices,
      }),
      ev("need.resolved", {
        needId: "n1",
        decision: "answered",
        by: "you",
        choice: "Keep it",
        scope: "chat",
      }),
      ev("decision.recorded", {
        decisionId: "d2",
        needId: "",
        projectId: "app",
        question: "Delete build/?",
        choice: "Delete it",
        scope: "chat",
        by: "ion",
        fromDecidedAt: "2026-11-18T09:00:00.000Z",
      }),
    );
    expect(t.items).toEqual([
      {
        kind: "question",
        needId: "n1",
        question: "Delete build/?",
        why: "2 GB",
        choices,
        answered: "Keep it",
      },
      { kind: "ion", tone: "answer", text: "Answered by ion from your decision on 18 Nov: Delete it" },
    ]);
  });

  it("knows the run that's going, from queued until it finishes", () => {
    expect(play(ev("run.queued", {})).running).toBe("r1");
    expect(play(ev("run.queued", {}), ev("run.started", {})).running).toBe("r1");
    expect(play(ev("run.queued", {}), ev("run.finished", { status: "done" })).running).toBeNull();
  });

  it("counts file changes and finished runs, so the changes panel knows to look again", () => {
    expect(play().changes).toBe(0);
    const t = play(ev("file.changed", { path: "a" }), ev("run.finished", { status: "done" }));
    expect(t.changes).toBe(2);
  });

  it("remembers the agent the chat last ran on, for the next message", () => {
    expect(play().harness).toBeNull();
    expect(play(ev("run.started", { harness: "grok-build" })).harness).toBe("grok-build");
  });

  it("shows errors and retries", () => {
    const t = play(
      ev("error", { code: "rate_limit", retryable: true, message: "Rate limited" }),
      ev("run.retrying", { attempt: 1, delayS: 4, reason: "Rate limited" }),
    );
    expect(t.items).toEqual([
      { kind: "error", text: "Rate limited" },
      { kind: "ion", tone: "note", text: "Retrying in 4s (rate limited)" },
    ]);
  });
});
