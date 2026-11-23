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

  // The user, 2026-11-21: "/" and "@" picks show as chips on your message, not as text.
  it("keeps your message's picks for its chips", () => {
    const t = play(ev("message.sent", { text: "Fill it", skills: ["pdf"], mentions: ["github"] }));
    expect(t.items).toEqual([
      { kind: "you", text: "Fill it", picked: { skills: ["pdf"], mentions: ["github"] } },
    ]);
  });

  // The user, 2026-11-20 (Plan 18): a run that goes without one of your MCP servers says why in a plain line.
  it("says plainly when a run goes without one of your servers", () => {
    const text = "github isn't signed in, so this chat runs without it.";
    const t = play(ev("message.sent", { text: "Hi" }), ev("tool.skipped", { id: "github", text }));
    expect(t.items.at(-1)).toEqual({ kind: "ion", tone: "note", text });
  });

  // The user, 2026-11-21 (Plan 20): a limit handed to another agent shows one line, never ion's brief as your message;
  // your choice shows under ion's question.
  it("shows a handoff as one line, with your choice under the question and no brief", () => {
    const choices = [
      { label: "Continue on Grok Build", consequence: "" },
      { label: "Wait", consequence: "" },
    ];
    const t = play(
      ev("message.sent", { text: "Add a dark mode" }),
      ev("need.raised", {
        needId: "n1",
        kind: "ask",
        summary: "opencode hit its limit. Continue on Grok Build, or wait?",
        detail: null,
        choices,
      }),
      ev("message.sent", { text: "<ion-data …> brief", handoff: true, answers: "n1" }, undefined, "r2"),
      ev("need.resolved", {
        needId: "n1",
        decision: "answered",
        by: "you",
        choice: "Continue on Grok Build",
        scope: "chat",
      }),
      ev("chat.handoff", { kind: "continued", text: "Continued on Grok Build — opencode hit its limit" }),
    );
    expect(t.items.filter((x) => x.kind === "you")).toEqual([{ kind: "you", text: "Add a dark mode" }]);
    const q = t.items.find((x) => x.kind === "question");
    expect(q).toMatchObject({ outcome: { by: "you", choice: "Continue on Grok Build" } });
    expect(q).not.toHaveProperty("replied");
    expect(t.items.at(-1)).toEqual({
      kind: "ion",
      tone: "note",
      text: "Continued on Grok Build — opencode hit its limit",
    });
  });

  // Security review, 2026-11-22: a chat's preference waits for you to keep it; the chat says so in one quiet line.
  it("says a chat's preference was saved as a suggestion", () => {
    const header = { name: "Tabs", description: "d", type: "preference", see: "chats", suggested: "app" };
    const written = {
      path: "you/tabs.md",
      scope: "you",
      slug: "tabs",
      header,
      hash: "h",
      by: { chatId: "c1", runId: "r1" },
    };
    const t = play(ev("message.sent", { text: "Hi" }), ev("memory.written", written));
    // Task 5, 2026-11-22 (tour): "keep it for every project?" asked a question the chat had no way to answer; it
    // now says what was suggested, with a link to Memory, where Keep is.
    expect(t.items.at(-1)).toEqual({ kind: "suggested", name: "Tabs" });
    const fact = {
      ...written,
      path: "projects/app/x.md",
      header: { ...header, type: "fact", suggested: undefined },
    };
    expect(play(ev("memory.written", fact)).items).toEqual([]);
  });

  // The user, 2026-11-21: "does memory cover todo as well". A chat that adds a to-do says so in one quiet line, with
  // a link to your to-dos; changing one says nothing.
  it("says a chat added a to-do", () => {
    const written = {
      path: "projects/app/check-mobile.md",
      scope: { projectId: "app" },
      slug: "check-mobile",
      header: {
        name: "Check the headline on mobile",
        description: "d",
        type: "todo",
        see: "chats",
        status: "open",
      },
      hash: "h",
      by: { chatId: "c1", runId: "r1" },
    };
    const t = play(ev("message.sent", { text: "Hi" }), ev("memory.written", written));
    expect(t.items.at(-1)).toEqual({ kind: "todo", name: "Check the headline on mobile" });
    const changed = { ...written, before: { hash: "g", text: "x" } };
    expect(play(ev("memory.written", changed)).items).toEqual([]);
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
      ev("tool.finished", { toolId: "t2", ok: false, summary: null }),
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
        outcome: { by: "you", choice: "Keep it" },
      },
      {
        kind: "question",
        needId: "",
        question: "Delete build/?",
        why: null,
        choices: [],
        resolved: true,
        outcome: { by: "ion", text: "Answered by ion from your decision: Delete it" },
      },
    ]);
  });

  // The user, 2026-11-21: "for the question box, after answering, it should appear inline as part of the
  // conversation with the question and answer".
  it("an answered question shows in the chat with your answer", () => {
    const choices = [
      { label: "Keep xs", consequence: "Nothing changes" },
      { label: "Drop xs", consequence: "9 components shift" },
    ];
    const t = play(
      ev("message.sent", { text: "Move us to Tailwind 4" }),
      ev("need.raised", { needId: "n1", kind: "ask", summary: "Keep xs?", detail: null, choices }),
      ev("need.resolved", {
        needId: "n1",
        decision: "answered",
        by: "you",
        choice: "Keep xs",
        scope: "project",
      }),
      // Your answer goes to the agent as the next message: it's the answer shown under the question, not again.
      ev("message.sent", { text: 'The user answered "Keep xs?": Keep xs', shown: "Keep xs", answers: "n1" }),
      ev("message.sent", { text: "Thanks" }),
    );
    const shown = t.items.filter((i) => !(i.kind === "you" && i.gone));
    expect(shown.map((i) => i.kind)).toEqual(["you", "question", "you"]);
    expect(shown[1]).toMatchObject({
      resolved: true,
      outcome: { by: "you", choice: "Keep xs", always: "Always" },
    });
    expect(shown[2]).toEqual({ kind: "you", text: "Thanks" });
  });

  // Found on the tour, 2026-11-21: ion sends your answer to the agent before it marks the question answered, so the
  // answer showed twice. Security review, 2026-11-21: matched by the question it answers, never by its words, so a
  // later message that reads the same stays.
  it("an answer sent before its question is marked answered still shows once", () => {
    const t = play(
      ev("need.raised", { needId: "n1", kind: "ask", summary: "Merge?", detail: null, choices: [] }),
      ev("message.completed", { text: "I asked you whether to merge." }),
      ev("message.sent", { text: 'The user answered "Merge?": Merge', shown: "Merge", answers: "n1" }),
      ev("need.resolved", { needId: "n1", decision: "answered", by: "you", choice: "Merge", scope: "chat" }),
      ev("message.sent", { text: "Merge", shown: "Merge" }),
    );
    const shown = t.items.filter((i) => i.kind === "you" && !i.gone);
    expect(shown.map((i) => (i.kind === "you" ? i.text : ""))).toEqual(["Merge"]);
    expect(t.items[0]).toMatchObject({ outcome: { by: "you", choice: "Merge" } });
  });

  // Tour, 2026-11-21: the agent's "Asked." showed after your answer (the answer sat under the question). Your answer
  // now shows where you sent it, after what the agent said; the question stays where it was asked.
  it("your answer shows where you sent it, after the agent's last words", () => {
    for (const answerFirst of [true, false]) {
      const raised = ev("need.raised", {
        needId: "n1",
        kind: "ask",
        summary: "Merge?",
        detail: null,
        choices: [],
      });
      const asked = ev("message.completed", { text: "Asked." });
      const resolved = ev("need.resolved", {
        needId: "n1",
        decision: "answered",
        by: "you",
        choice: "Merge",
        scope: "project",
      });
      const sentAnswer = ev("message.sent", {
        text: 'The user answered "Merge?": Merge',
        shown: "Merge",
        answers: "n1",
      });
      const t = play(raised, asked, ...(answerFirst ? [resolved, sentAnswer] : [sentAnswer, resolved]));
      expect(t.items.map((i) => i.kind)).toEqual(["question", "agent", "you"]);
      expect(t.items[0]).toMatchObject({ replied: true, outcome: { by: "you", choice: "Merge" } });
      expect(t.items[2]).toMatchObject({ kind: "you", text: "Merge", answers: "n1", always: "Always" });
    }
  });

  it("a message that reads the same as an answer stays visible", () => {
    const t = play(
      ev("need.raised", { needId: "n1", kind: "ask", summary: "Merge?", detail: null, choices: [] }),
      ev("message.sent", { text: "Merge" }),
      ev("need.resolved", { needId: "n1", decision: "answered", by: "you", choice: "Merge", scope: "chat" }),
      ev("message.sent", { text: 'The user answered "Merge?": Merge', shown: "Merge", answers: "n1" }),
    );
    // Your own "Merge" stays where you typed it; the answer is the one under the question.
    expect(t.items[1]).toEqual({ kind: "you", text: "Merge" });
    expect(t.items.filter((i) => i.kind === "you" && !i.gone)).toHaveLength(1);
  });

  // Task review, 2026-11-21: a held question asked again shows nothing; one with an unknown question isn't hidden;
  // answers in chats from before ion named the question show once.
  it("a released held question shows nothing", () => {
    const t = play(
      ev("need.raised", {
        needId: "h1",
        kind: "ask",
        summary: "Q?",
        detail: null,
        choices: [],
        heldFor: "n0",
      }),
      ev("need.resolved", { needId: "h1", decision: "superseded", by: "daemon", why: "asked again" }),
    );
    expect(t.items[0]).not.toHaveProperty("outcome");
  });

  it("an answer naming a question that isn't here stays visible", () => {
    const t = play(ev("message.sent", { text: "x", shown: "Yes", answers: "elsewhere" }));
    expect(t.items).toEqual([{ kind: "you", text: "Yes" }]);
  });

  it("answers in older chats (no question named) show once, either order", () => {
    const raised = ev("need.raised", {
      needId: "n1",
      kind: "ask",
      summary: "Merge?",
      detail: null,
      choices: [],
    });
    const resolved = ev("need.resolved", { needId: "n1", decision: "answered", by: "you", choice: "Merge" });
    const sentOld = ev("message.sent", { text: 'The user chose: "Merge".', shown: "Merge" });
    for (const order of [
      [raised, sentOld, resolved],
      [raised, resolved, sentOld],
    ]) {
      const t = order.reduce(reduce, empty());
      expect(t.items.filter((i) => i.kind === "you" && !i.gone)).toEqual([]);
    }
  });

  it("says why a question ended without you", () => {
    const t = play(
      ev("need.raised", { needId: "n1", kind: "ask", summary: "Q?", detail: null, choices: [] }),
      ev("need.resolved", { needId: "n1", decision: "superseded", by: "daemon", why: "archived" }),
    );
    expect(t.items[0]).toMatchObject({ outcome: { by: "stopped", why: "archived" } });
  });

  it("a question that ended without you shows what happened", () => {
    const t = play(
      ev("need.raised", { needId: "n1", kind: "ask", summary: "Q?", detail: null, choices: [] }),
      ev("need.resolved", { needId: "n1", decision: "superseded", by: "daemon" }),
    );
    expect(t.items[0]).toMatchObject({ kind: "question", resolved: true, outcome: { by: "stopped" } });
  });

  // The user, 2026-11-21: after an agent adds a tool, ion says so in the chat, with a link to Settings → Tools.
  it("the chat shows a line after an agent adds", () => {
    const t = play(ev("tool.added", { kind: "mcp", name: "github" }));
    expect(t.items).toEqual([{ kind: "added", tool: "mcp", name: "github" }]);
  });

  it("knows the run that's going, from queued until it finishes", () => {
    expect(play(ev("run.queued", {})).running).toBe("r1");
    expect(play(ev("run.queued", {}), ev("run.started", {})).running).toBe("r1");
    expect(play(ev("run.queued", {}), ev("run.finished", { status: "done" })).running).toBeNull();
  });

  // The user, 2026-11-22: a chat ion started that waits for a slot says why, until it starts.
  it("says why an ion chat waits for a slot, until it starts", () => {
    const queued = ev("run.queued", { access: "auto", waiting: "Waiting — 4 ion chats running" });
    expect(play(queued).waiting).toBe("Waiting — 4 ion chats running");
    expect(play(queued, ev("run.started", {})).waiting).toBeNull();
    expect(play(queued, ev("run.finished", { status: "interrupted" })).waiting).toBeNull();
  });

  // The user, 2026-11-22: Pick by usage says why it picked the chat's agent, in one line, in the chat's header.
  it("keeps why Pick by usage picked the chat's agent", () => {
    const t = play(
      ev(
        "chat.handoff",
        { kind: "routed", text: "On Codex — Claude Code is near its limit", to: "codex" },
        undefined,
        null as never,
      ),
    );
    expect(t.routed).toBe("On Codex — Claude Code is near its limit");
    expect(t.items).toEqual([]);
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

  // Tour, 2026-11-21: opencode's bash steps showed "bash", not their command; the command it only knew later wins.
  it("takes a summary the harness only knew when the tool finished", () => {
    const t = play(
      ev("tool.started", { toolId: "t1", name: "execute", kind: "command", summary: "bash" }),
      ev("tool.finished", { toolId: "t1", ok: true, summary: "pnpm test", input: '{"command":"pnpm test"}' }),
      ev("tool.started", { toolId: "t2", name: "Read", kind: "read", summary: "a.ts" }),
      ev("tool.finished", { toolId: "t2", ok: true, summary: null }),
    );
    expect(t.items[0]).toMatchObject({
      steps: [{ summary: "pnpm test" }, { summary: "a.ts" }],
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
        detail: "ion thinks this is risky: x",
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

  // Task 11, 2026-11-22 (live): a stopped call answered "Don't allow" with Remember showed "Don't allow · Always"; it
  // says Remember, the box's own word.
  it("a remembered answer to a stopped call says Remember", () => {
    const t = play(
      ev("need.raised", {
        ...{ needId: "n1", requestId: "g4", kind: "ask", summary: "Allow this? npm publish", detail: "x" },
        ...{ dedupeKey: "k", choices: [], blocked: true },
      }),
      ev("need.resolved", {
        needId: "n1",
        decision: "answered",
        by: "you",
        choice: "Don't allow",
        scope: "project",
      }),
    );
    expect(t.items[0]).toMatchObject({ outcome: { by: "you", choice: "Don't allow", always: "Remember" } });
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
    // (Task review, 2026-11-21: marked as maybe an older chat's answer, matched to its question by label.)
    expect(t.items).toEqual([{ kind: "you", text: "Green", legacy: true }]);
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
  // The composer starts from the chat's own brain.
  it("keeps the model and effort of the chat's latest run", () => {
    const t = play(ev("run.started", { harness: "grok-build", model: "grok-code-fast", effort: "high" }));
    expect(t).toMatchObject({ harness: "grok-build", model: "grok-code-fast", effort: "high" });
  });
});
