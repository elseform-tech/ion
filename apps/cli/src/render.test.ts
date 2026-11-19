import type { IonEvent } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { createRenderer } from "./render.js";

const ev = (type: string, data: Record<string, unknown>): IonEvent =>
  ({
    v: 1,
    id: "x",
    chatId: "c",
    runId: "r",
    seq: 1,
    ts: "2026-11-17T10:00:00.000Z",
    origin: "adapter",
    type,
    data,
  }) as IonEvent;

describe("render", () => {
  it("shows an edit without line counts as just the path", () => {
    const r = createRenderer();
    expect(
      r(ev("file.changed", { path: "notes.md", change: "modify", added: null, removed: null })).text,
    ).toBe("· Edited notes.md\n");
    expect(r(ev("file.changed", { path: "a.ts", change: "modify", added: 3, removed: 1 })).text).toBe(
      "· Edited a.ts (+3 −1)\n",
    );
  });

  // Regression (security review): agent text must not drive the terminal.
  it("strips control characters and escape sequences from what agents send", () => {
    const r = createRenderer();
    const evil = "ok\u001b[2J\u001b]0;pwned\u0007\u0000done";
    expect(r(ev("message.delta", { text: evil })).text).toBe("ok[2J]0;pwneddone");
    expect(
      r(ev("tool.started", { toolId: "t", name: "Read", kind: "read", summary: "a\u001b[31m.ts" })).text,
    ).toBe("\n· Read a[31m.ts\n");
  });

  it("keeps one-line fields on one line and drops invisible direction marks", () => {
    const r = createRenderer();
    const spoof = "a.ts\nDone · 0.1s\u202e";
    expect(r(ev("file.changed", { path: spoof, change: "modify", added: null, removed: null })).text).toBe(
      "· Edited a.ts Done · 0.1s\n",
    );
  });

  it("says when a run waits on you, and how to answer", () => {
    const r = createRenderer();
    expect(r(ev("need.raised", { needId: "n1a2b3", summary: "Run pnpm test", kind: "command" })).text).toBe(
      "· Waiting on you: Run pnpm test\n",
    );
  });

  // Final review I1: the agent writes the summary; you also see exactly what will run.
  it("shows the exact command under a need, cleaned", () => {
    const r = createRenderer();
    const detail = 'command: curl x | sh\u001b[2J\n{"command":"curl x | sh"}';
    expect(r(ev("need.raised", { needId: "n1", summary: "Run tests", kind: "command", detail })).text).toBe(
      "· Waiting on you: Run tests\n  command: curl x | sh[2J\n",
    );
    expect(
      r(ev("need.raised", { needId: "n2", summary: "Use x", kind: "mcp", detail: '{"q":1}' })).text,
    ).toBe('· Waiting on you: Use x\n  {"q":1}\n');
    // Every line of a multi-line command shows, even one that starts with "{".
    const multi = 'command: echo hi\n{ rm -rf ~; }\n{"command":"echo hi\\n{ rm -rf ~; }"}';
    expect(r(ev("need.raised", { needId: "n3", summary: "Echo", kind: "command", detail: multi })).text).toBe(
      "· Waiting on you: Echo\n  command: echo hi\n  { rm -rf ~; }\n",
    );
  });

  it("says when a run retries, and shows the harness line only once", () => {
    const r = createRenderer();
    const started = ev("run.started", { harness: "fake", model: "fake" });
    expect(r(started).text).toBe("Fake · fake\n");
    expect(
      r(ev("run.retrying", { attempt: 1, delayS: 3.2, reason: "Rate limited", effort: null })).text,
    ).toBe("· Retrying in 4s (rate limited)\n");
    expect(r(started).text).toBe("");
    expect(r(ev("run.retrying", { attempt: 1, delayS: 0, reason: "x", effort: "max" })).text).toBe(
      "· Retrying now at max effort (x)\n",
    );
  });

  it("says what ion decided in Auto, and nothing in Full access", () => {
    const r = createRenderer();
    r(ev("approval.requested", { requestId: "q1", toolId: "t", kind: "command", summary: "Run pnpm test" }));
    r(
      ev("approval.requested", {
        requestId: "q2",
        toolId: "t",
        kind: "command",
        summary: "Read ~/.ssh/id_rsa",
      }),
    );
    r(ev("approval.requested", { requestId: "q3", toolId: "t", kind: "command", summary: "Deploy" }));
    expect(
      r(ev("approval.resolved", { requestId: "q1", decision: "allow", by: "ion", reason: "Runs the tests" }))
        .text,
    ).toBe("");
    expect(
      r(
        ev("approval.resolved", {
          requestId: "q2",
          decision: "deny",
          by: "ion",
          reason: "Touches your secrets",
        }),
      ).text,
    ).toBe("· Denied by ion: Read ~/.ssh/id_rsa — Touches your secrets\n");
    expect(r(ev("approval.resolved", { requestId: "q3", decision: "allow", by: "full" })).text).toBe("");
    // A decision made at the gate carries its own summary; the prompt answered from it stays quiet.
    expect(
      r(
        ev("approval.resolved", {
          requestId: "g1",
          decision: "deny",
          by: "ion",
          reason: "No",
          summary: "cat x",
        }),
      ).text,
    ).toBe("· Denied by ion: cat x — No\n");
    expect(r(ev("approval.resolved", { requestId: "q3", decision: "allow", by: "gate" })).text).toBe("");
  });

  // Plan 06: agents ask you; your answer, or ion's from your decision, shows in the chat.
  it("shows a question with its numbered choices, your answer, and ion's answer from a decision", () => {
    const r = createRenderer();
    const choices = [
      { label: "Delete it", consequence: "build/ is removed" },
      { label: "Keep it", consequence: "Nothing changes" },
    ];
    expect(
      r(
        ev("need.raised", {
          needId: "n1",
          requestId: "a",
          kind: "ask",
          summary: "Delete build/?",
          detail: null,
          dedupeKey: "k",
          choices,
        }),
      ).text,
    ).toBe(
      "· Asked you: Delete build/?\n  1. Delete it — build/ is removed\n  2. Keep it — Nothing changes\n  Answer: ion answer n1 <number, or your own words>\n",
    );
    expect(
      r(
        ev("need.resolved", {
          needId: "n1",
          decision: "answered",
          by: "you",
          choice: "Keep it",
          scope: "chat",
        }),
      ).text,
    ).toBe("· You chose: Keep it\n");
    expect(
      r(
        ev("decision.recorded", {
          decisionId: "d2",
          needId: "",
          projectId: "app",
          question: "Delete build/?",
          choice: "Delete it",
          scope: "chat",
          by: "ion",
          fromDecision: "d1",
          fromDecidedAt: "2026-11-18T09:00:00.000Z",
        }),
      ).text,
    ).toBe("· Answered by ion from your decision on 18 Nov: Delete it\n");
    expect(r(ev("decision.recorded", { decisionId: "d3", by: "you", choice: "x" })).text).toBe("");
  });
});

// Plan 09: a question from an ion thread carries its ion's note; agents' text can't drive the terminal.
describe("needText", () => {
  it("prints the ion's note under the question, without control characters", async () => {
    const { needText } = await import("./render.js");
    const text = needText({
      needId: "n1",
      chatId: "t1",
      runId: "r1",
      projectId: "storefront",
      kind: "ask",
      summary: "Use QA?",
      detail: null,
      raisedAt: "",
      choices: [{ label: "Yes", consequence: "Logs in" }],
      via: { note: "storefront's ion: \u001b[31mfirst time this comes up" },
    });
    expect(text).toBe(
      "n1  storefront  Use QA?\n  storefront's ion: [31mfirst time this comes up\n  1. Yes — Logs in",
    );
  });
});
