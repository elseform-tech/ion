// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import { type ChatInfo, EV, type IonEvent, type IonInfo } from "@ion/schema";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ionTimeline } from "./ionTimeline.js";
import { Ions } from "./Ions.js";

afterEach(cleanup);

let seq = 0;
const ev = (chatId: string, type: string, data: Record<string, unknown>): IonEvent =>
  ({
    v: 1,
    id: `e${++seq}`,
    chatId,
    runId: null,
    seq,
    ts: "2026-11-18T10:00:00.000Z",
    origin: "daemon",
    type,
    data,
  }) as IonEvent;

const ions: IonInfo[] = [
  {
    ionId: "chief",
    name: "ion",
    color: null,
    harness: null,
    last: "Asked 1 project.",
    needs: 1,
    working: false,
  },
  {
    ionId: "storefront",
    name: "storefront",
    color: "#ED712E",
    harness: "claude-code",
    last: "On it.",
    needs: 0,
    working: true,
  },
];
const thread: ChatInfo = {
  chatId: "t1",
  title: "Fix the cart",
  projectId: "storefront",
  branch: "ion/t1",
  archived: false,
  lastRunStatus: "running",
  lastActivityAt: null,
  preview: null,
  by: "ion",
};

/** A client with these ions, chats and an ion chat's events. */
function client(events: IonEvent[] = []) {
  const call = vi.fn(async (cmd: string) => {
    if (cmd === "ions.list") return ions;
    if (cmd === "chats.list") return [thread];
    if (cmd === "needs.list")
      return [
        {
          needId: "n1",
          chatId: "t1",
          runId: "r1",
          projectId: "storefront",
          kind: "ask",
          summary: "Use QA?",
          detail: null,
          raisedAt: "",
        },
      ];
    return cmd === "ion.message" || cmd === "suggestion.answer" ? { ok: true } : [];
  });
  const subscribe = vi.fn(async (q: { chatId?: string }, fn: (e: IonEvent) => void) => {
    for (const e of events) if (!q.chatId || e.chatId === q.chatId) fn(e);
    return () => {};
  });
  return { call, subscribe } as unknown as IonClient & { call: typeof call };
}

// Plan 09: the Ions screen.
describe("ionTimeline", () => {
  it("turns an ion's chat into your messages, its lines and its cards, in order", () => {
    const card = { kind: "threads", threads: [{ chatId: "t1", projectId: "storefront" }] };
    expect(
      ionTimeline([
        ev("ion:storefront", EV.ionHeard, { text: "Fix the cart" }),
        ev("ion:storefront", EV.ionSaid, { text: "On it.", card }),
      ]),
    ).toEqual([
      { kind: "you", text: "Fix the cart" },
      { kind: "ion", text: "On it.", card },
    ]);
  });
});

describe("Ions", () => {
  it("lists ion chief first, then each project's ion, with needs and work", async () => {
    const { container } = render(<Ions client={client()} onOpenChat={() => {}} />);
    await waitFor(() => expect(container.querySelector(".pmain")).not.toBeNull());
    expect(container.querySelector(".chief .nb")?.textContent).toBe("1");
    expect(container.querySelector(".pmain b")?.textContent).toBe("storefront");
    expect(container.querySelector(".pmain small.now")?.textContent).toBe("On it.");
  });

  it("sends your message to the open ion", async () => {
    const c = client();
    render(<Ions client={c} onOpenChat={() => {}} />);
    const box = await screen.findByLabelText("Message ion");
    fireEvent.change(box, { target: { value: "Anything for me?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(c.call).toHaveBeenCalledWith("ion.message", { ionId: "chief", text: "Anything for me?" });
  });

  it("opens a thread from its card, and answers a suggestion", async () => {
    const onOpenChat = vi.fn();
    const c = client([
      ev("ion:chief", EV.ionSaid, {
        text: "Asked 1 project.",
        card: { kind: "threads", threads: [{ chatId: "t1", projectId: "storefront" }] },
      }),
      ev("ion:chief", EV.ionSaid, {
        text: "Always?",
        card: { kind: "suggest", suggestionId: "s1", question: "Use QA?", choice: "Yes" },
      }),
    ]);
    const { container } = render(<Ions client={c} onOpenChat={onOpenChat} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Fix the cart/ }));
    expect(container.querySelector(".tlink")).not.toBeNull();
    expect(onOpenChat).toHaveBeenCalledWith("t1");
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(c.call).toHaveBeenCalledWith("suggestion.answer", { suggestionId: "s1", keep: true });
  });

  // Review Focus 5.
  it("shows HTML in an ion's words or a thread's title as text", async () => {
    const c = client([ev("ion:chief", EV.ionSaid, { text: '<img src=x onerror="alert(1)">' })]);
    const { container } = render(<Ions client={c} onOpenChat={() => {}} />);
    await screen.findByText('<img src=x onerror="alert(1)">');
    expect(container.querySelector("img")).toBeNull();
    await act(async () => {});
  });
  // The lab: what needs you is pinned atop ion chief's chat, one quiet line until you open it.
  it("pins what needs you atop ion chief's chat, and opens a question's chat", async () => {
    const onOpenChat = vi.fn();
    const { container } = render(<Ions client={client()} onOpenChat={onOpenChat} />);
    const mini = await screen.findByRole("button", { name: /Needs you/ });
    expect(container.querySelector(".pins.mini .peek")?.textContent).toBe("Use QA?");
    fireEvent.click(mini);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpenChat).toHaveBeenCalledWith("t1");
  });
  // The lab: several threads from one message are one fan-out card, a row per project's ion.
  it("shows several threads as one fan-out card", async () => {
    const two = [
      { chatId: "t1", projectId: "storefront" },
      { chatId: "t2", projectId: "storefront" },
    ];
    const c = client([
      ev("ion:chief", EV.ionSaid, { text: "Asked 2 projects.", card: { kind: "threads", threads: two } }),
    ]);
    const { container } = render(<Ions client={c} onOpenChat={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll(".fan .fanr")).toHaveLength(2));
    expect(container.querySelector(".fan .fanh")?.textContent).toBe("Asked 2 projects");
    expect(container.querySelector(".tlink")).toBeNull();
  });
});
