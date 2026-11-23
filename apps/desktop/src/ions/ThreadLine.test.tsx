// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import { type ChatInfo, EV, type IonEvent } from "@ion/schema";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadLine } from "./ThreadLine.js";

afterEach(cleanup);

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, ts: string): IonEvent =>
  ({ v: 1, id: `e${++seq}`, chatId: "t1", runId: "r1", seq, ts, origin: "daemon", type, data }) as IonEvent;

const chat = (lastRunStatus: string): ChatInfo => ({
  chatId: "t1",
  title: "Fix the cart",
  projectId: "storefront",
  branch: "ion/t1",
  archived: false,
  lastRunStatus,
  lastActivityAt: null,
  preview: null,
  by: "ion",
});

const line = (events: IonEvent[], c: ChatInfo, call = vi.fn()) => {
  const subscribe = vi.fn(async (_q: unknown, fn: (e: IonEvent) => void) => {
    for (const e of events) fn(e);
    return () => {};
  });
  return render(
    <ThreadLine
      client={{ subscribe, call } as unknown as IonClient}
      chatId="t1"
      projectId="storefront"
      chat={c}
      on={false}
      onOpen={() => {}}
    />,
  );
};

const started = ev(
  EV.runStarted,
  { harness: "fake", model: "m", effort: null, authMethod: null },
  "2026-11-19T10:00:00Z",
);
const tool = ev(
  EV.toolStarted,
  { toolId: "x", kind: "read", name: "Read", summary: "a.ts" },
  "2026-11-19T10:00:01Z",
);

// The user, 2026-11-19: once done, a thread's line reads its title and how long it took; while it waits on you, it
// says so (no shimmer: nothing moves until you answer).
describe("a thread's line", () => {
  it("reads its title and how long it took once done", async () => {
    const done = ev(EV.runFinished, { status: "done" }, "2026-11-19T10:01:04Z");
    const { container } = line([started, tool, done], chat("done"));
    await waitFor(() => expect(container.querySelector(".tt")?.textContent).toBe("Fix the cart"));
    expect(container.querySelector(".now")).toBeNull();
    expect(container.querySelector(".wn")?.textContent).toBe("· 1m 04s");
  });

  it("says it's waiting for you while a question is open", async () => {
    const ask = ev(
      EV.needRaised,
      { needId: "n1", kind: "ask", summary: "Use QA?", detail: null, choices: [{ id: "y", label: "Yes" }] },
      "2026-11-19T10:00:02Z",
    );
    const { container } = line([started, tool, ask], chat("running"));
    await waitFor(() => expect(container.querySelector(".tt")?.textContent).toBe("Waiting for you"));
    expect(container.querySelector(".now")).toBeNull();
    expect(container.querySelector(".wd")).not.toBeNull();
  });
});

// The user, 2026-11-21: an ion's thread line says what such a task usually takes, on hover, from past chats.
describe("a thread's estimate", () => {
  it("shows on hover, and nothing when there are too few past chats", async () => {
    const done = ev(EV.runFinished, { status: "done" }, "2026-11-19T10:01:04Z");
    const call = vi.fn(async () => ({ unit: "tokens", low: 40_000, high: 120_000 }));
    const { container } = line([started, done], chat("done"), call);
    await waitFor(() =>
      expect(container.querySelector(".tl")?.getAttribute("title")).toBe("usually 40–120k tokens"),
    );
    expect(call).toHaveBeenCalledWith("usage.estimate", { chatId: "t1" });
    cleanup();
    const none = line(
      [started, done],
      chat("done"),
      vi.fn(async () => null),
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(none.container.querySelector(".tl")?.getAttribute("title")).toBeNull();
  });
});

// The user, 2026-11-21: answered questions stay in the conversation, "the same in ion threads".
describe("a thread open beside its ion's chat", () => {
  it("the same in an ion thread: the question and your answer stay where it was asked", async () => {
    const { ThreadPeek } = await import("./ThreadLine.js");
    const ask = ev(
      EV.needRaised,
      {
        needId: "n1",
        kind: "ask",
        summary: "Use QA?",
        detail: null,
        choices: [{ label: "Yes", consequence: "" }],
      },
      "2026-11-19T10:00:02Z",
    );
    const answer = ev(
      EV.needResolved,
      { needId: "n1", decision: "answered", by: "you", choice: "Yes", scope: "chat" },
      "2026-11-19T10:00:03Z",
    );
    const subscribe = vi.fn(async (_q: unknown, fn: (e: IonEvent) => void) => {
      for (const e of [started, ask, answer]) fn(e);
      return () => {};
    });
    const { container } = render(
      <ThreadPeek
        client={{ subscribe, call: vi.fn(async () => []) } as unknown as IonClient}
        chat={chat("running")}
        onClose={() => {}}
        onOpenChat={() => {}}
      />,
    );
    await waitFor(() => expect(container.querySelector(".qa .qq")?.textContent).toBe("Use QA?"));
    expect(container.querySelector(".u")?.textContent).toBe("Yes");
    expect(container.querySelector(".qbox")).toBeNull();
  });
});
