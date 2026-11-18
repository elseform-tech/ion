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

  // Plan 08: the lab's one umbrella per turn, with its steps and how long it worked.
  it("groups a run's thinking and tools under one work item, with when it started and ended", () => {
    const t = play(
      ev("run.started", { harness: "fake" }, "2026-11-18T10:00:00.000Z"),
      ev("thinking.delta", { text: "Look at " }, "2026-11-18T10:00:01.000Z"),
      ev("thinking.delta", { text: "the totals" }, "2026-11-18T10:00:05.000Z"),
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
        started: "2026-11-18T10:00:00.000Z",
        ended: "2026-11-18T10:02:04.000Z",
        steps: [
          {
            kind: "think",
            text: "Look at the totals",
            from: "2026-11-18T10:00:01.000Z",
            to: "2026-11-18T10:00:05.000Z",
          },
          { kind: "tool", toolKind: "read", name: "Read", summary: "a.ts", ok: true },
          { kind: "tool", toolKind: "command", name: "Bash", summary: "pnpm test", ok: false },
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
        resolved: true,
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

  // Final review I1: a question whose run stopped is closed too, so it never sits in (or returns to) the bar.
  it("closes a question that was superseded, without saying you chose anything", () => {
    const choices = [
      { label: "A", consequence: "a" },
      { label: "B", consequence: "b" },
    ];
    const t = play(
      ev("need.raised", {
        needId: "n1",
        requestId: "a",
        kind: "ask",
        summary: "Q?",
        detail: null,
        dedupeKey: "k",
        choices,
      }),
      ev("need.resolved", { needId: "n1", decision: "superseded", by: "daemon" }),
    );
    expect(t.items[0]).toMatchObject({ kind: "question", resolved: true });
    expect(t.items[0]).not.toHaveProperty("answered");
  });

  it("keeps each tool's input and output, including input that arrives when it ends", () => {
    const t = play(
      ev("tool.started", {
        toolId: "t1",
        name: "Bash",
        kind: "command",
        summary: "ls",
        input: '{"command":"ls"}',
      }),
      ev("tool.output", { toolId: "t1", text: "a.ts\n" }),
      ev("tool.output", { toolId: "t1", text: "b.ts" }),
      ev("tool.finished", { toolId: "t1", ok: true, summary: null }),
      ev("tool.started", { toolId: "t2", name: "execute", kind: "command", summary: "pwd" }),
      ev("tool.finished", { toolId: "t2", ok: true, summary: null, input: '{"command":"pwd"}' }),
    );
    expect(t.items[0]).toMatchObject({
      kind: "work",
      steps: [
        { name: "Bash", input: '{"command":"ls"}', output: "a.ts\nb.ts", ok: true },
        { name: "execute", input: '{"command":"pwd"}', ok: true },
      ],
    });
  });

  it("marks ion's question about a stopped call as gone past its wait when ion says no", () => {
    const choices = [
      { label: "Allow once", consequence: "a" },
      { label: "Don't allow", consequence: "b" },
    ];
    const t = play(
      ev("need.raised", {
        needId: "n1",
        requestId: "g4",
        kind: "ask",
        summary: "Allow this? npm publish",
        detail: "ion stopped it: x",
        dedupeKey: "k",
        choices,
        blocked: true,
      }),
      ev("approval.resolved", {
        requestId: "g4",
        decision: "deny",
        by: "ion",
        reason: "No answer in 4 minutes",
        summary: "npm publish",
      }),
    );
    expect(t.items[0]).toMatchObject({ kind: "question", blocked: true, expired: true });
    expect(t.items[1]).toMatchObject({ kind: "ion", tone: "deny" });
  });

  // Plan 08, a quiet chat: an error is its message only; a retry is a countdown that goes once the retry starts.
  it("keeps errors to their message, and a retry until it starts", () => {
    const t = play(
      ev("error", { code: "rate_limit", retryable: true, message: "Rate limited" }),
      ev("run.retrying", { attempt: 1, delayS: 4, reason: "Rate limited" }, "2026-11-18T10:00:00.000Z"),
    );
    expect(t.items).toEqual([
      { kind: "error", text: "Rate limited", runId: "r1" },
      { kind: "retry", until: "2026-11-18T10:00:04.000Z", done: false },
    ]);
    const after = reduce(t, ev("run.started", { harness: "fake" }, "2026-11-18T10:00:04.100Z"));
    expect(after.items[1]).toEqual({ kind: "retry", until: "2026-11-18T10:00:04.000Z", done: true });
  });
  // Final review I1: a retry stopped during its countdown (no run.started follows) is done, not "Retrying in 0s".
  it("closes a retry when its run ends without starting again", () => {
    const t = play(
      ev("run.retrying", { attempt: 1, delayS: 4, reason: "Rate limited" }, "2026-11-18T10:00:00.000Z"),
      ev("run.finished", { status: "interrupted" }, "2026-11-18T10:00:01.000Z"),
    );
    expect(t.items[0]).toEqual({ kind: "retry", until: "2026-11-18T10:00:04.000Z", done: true });
  });
  // UX tour: an agent that keeps failing the same way is one line, not one per try.
  it("shows a run's repeated error once", () => {
    const err = () => ev("error", { code: "rate_limit", retryable: true, message: "Rate limited" });
    const t = play(err(), err(), err());
    expect(t.items).toEqual([{ kind: "error", text: "Rate limited", runId: "r1" }]);
  });

  // UX tour: a run that got through after retrying shows no errors.
  it("drops a run's errors once it finishes done", () => {
    const t = play(
      ev("error", { code: "rate_limit", retryable: true, message: "Rate limited" }),
      ev("run.finished", { status: "done" }),
    );
    expect(t.items.filter((x) => x.kind === "error" && !x.gone)).toEqual([]);
  });

  // UX tour: a failed run is one line saying why.
  it("ends a failed run with its last error as the reason", () => {
    const t = play(
      ev("error", { code: "rate_limit", retryable: true, message: "Rate limited" }),
      ev("run.finished", { status: "failed" }),
    );
    expect(t.items).toEqual([
      { kind: "error", text: "Rate limited", runId: "r1", gone: true },
      { kind: "end", status: "failed", seconds: 0, reason: "Rate limited" },
    ]);
  });
  // The user, 2026-11-18: a run's end lists the files it changed (the last counts for each path).
  it("ends a run with the files it changed", () => {
    const t = play(
      ev("file.changed", { path: "a.ts", change: "modify", added: 1, removed: 0 }),
      ev("file.changed", { path: "b.ts", change: "add", added: 4, removed: 0 }),
      ev("file.changed", { path: "a.ts", change: "modify", added: 2, removed: 1 }),
      ev("run.finished", { status: "done" }),
    );
    expect(t.items.at(-1)).toEqual({
      kind: "end",
      status: "done",
      seconds: 0,
      // Final review: each file.changed is one edit's counts, so they add up.
      files: [
        { path: "a.ts", added: 3, removed: 1 },
        { path: "b.ts", added: 4, removed: 0 },
      ],
    });
  });
  // The user, 2026-11-18: your answer shows as what you chose, not ion's wording for the agent.
  it("shows the message ion sent for your answer as your answer", () => {
    const t = play(
      ev("message.sent", { text: 'You asked: "Colour?". The user chose: "Green".', shown: "Green" }),
    );
    expect(t.items).toEqual([{ kind: "you", text: "Green" }]);
  });
  // Plan 09: an ion thread's question keeps its ion's note.
  it("keeps the ion's note on a question", () => {
    const t = play(
      ev("need.raised", {
        ...{ needId: "n1", requestId: "q", kind: "ask", summary: "Use QA?", detail: null, dedupeKey: "k" },
        choices: [{ label: "Yes", consequence: "x" }],
        via: { note: "storefront's ion: first time this comes up" },
      }),
    );
    expect(t.items[0]).toMatchObject({
      kind: "question",
      note: "storefront's ion: first time this comes up",
    });
  });
});
