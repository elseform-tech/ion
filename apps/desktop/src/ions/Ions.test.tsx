// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import { type ChatInfo, EV, type IonEvent, type IonInfo } from "@ion/schema";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    thinking: false,
    starred: false,
  },
  {
    ionId: "storefront",
    name: "storefront",
    color: "#ED712E",
    harness: "claude-code",
    last: "On it.",
    needs: 0,
    working: true,
    thinking: false,
    starred: true,
  },
  {
    ionId: "payments-api",
    name: "payments-api",
    color: "#5BC67A",
    harness: null,
    last: null,
    needs: 0,
    working: false,
    thinking: false,
    starred: false,
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
    if (cmd === "projects.list")
      return [
        { id: "storefront", path: "/p/s", starred: true },
        { id: "payments-api", path: "/p/p", starred: false },
      ];
    if (cmd === "chats.list") return [thread];
    if (cmd === "memory.list") return [{ memoryId: "you/a.md" }, { memoryId: "you/b.md" }];
    if (cmd === "activity.list") return { paused: false, upcoming: [], today: [], yesterday: [] };
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
        {
          needId: "n2",
          chatId: "mine",
          runId: "r2",
          projectId: "storefront",
          kind: "ask",
          summary: "Mine?",
          detail: null,
          raisedAt: "",
        },
      ];
    return ["ion.message", "suggestion.answer", "project.star", "project.create"].includes(cmd)
      ? { ok: true }
      : [];
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

  // The user, 2026-11-19: a thread an ion started is a line like a tool call's (what it's doing now, shimmering, and
  // for how long), not a box; it opens beside the ion's chat, like a chat's side panel.
  it("shows a thread as a line with what it's doing, opens it beside the chat, and answers a suggestion", async () => {
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
      {
        ...ev("t1", EV.runStarted, { harness: "fake", model: "m", effort: null, authMethod: null }),
        runId: "r1",
      },
      {
        ...ev("t1", EV.toolStarted, { toolId: "x", kind: "read", name: "Read", summary: "package.json" }),
        runId: "r1",
      },
    ]);
    const { container } = render(<Ions client={c} onOpenChat={onOpenChat} />);
    await waitFor(() =>
      expect(container.querySelector(".tl .tt.now")?.textContent).toBe("Read package.json"),
    );
    const line = container.querySelector<HTMLButtonElement>(".tl")!;
    expect(container.querySelector(".tlink, .fan")).toBeNull();
    fireEvent.click(line);
    expect(container.querySelector("aside.tpeek .title")?.textContent).toBe("Fix the cart");
    expect(onOpenChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open in Chats" }));
    expect(onOpenChat).toHaveBeenCalledWith("t1");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(container.querySelector("aside.tpeek")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(c.call).toHaveBeenCalledWith("suggestion.answer", { suggestionId: "s1", keep: true });
  });

  // Real run on Grok, 2026-11-19: an ion's report came with Markdown ("**0.15**", `split.js`) shown as is.
  it("reads an ion's Markdown as formatting, and still shows HTML as text", async () => {
    const c = client([ev("ion:chief", EV.ionSaid, { text: "The default tip in `split.js` is **0.15**." })]);
    const { container } = render(<Ions client={c} onOpenChat={() => {}} />);
    await waitFor(() => expect(container.querySelector(".bi strong")?.textContent).toBe("0.15"));
    expect(container.querySelector(".bi code")?.textContent).toBe("split.js");
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
    // Final review I10: only questions from threads ion started (your own chats' aren't ion's).
    expect(container.querySelector(".pins.mini .peek")?.textContent).toBe("Use QA?");
    expect(container.querySelector(".pins.mini .ct")?.textContent).toBe("1");
    fireEvent.click(mini);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpenChat).toHaveBeenCalledWith("t1");
  });
  // The user, 2026-11-19: an ion's threads' panel opens and closes from its header too, like a chat's side panel.
  it("shows and hides its latest thread from the header", async () => {
    const c = client([
      ev("ion:chief", EV.ionSaid, {
        text: "Asked 1 project.",
        card: { kind: "threads", threads: [{ chatId: "t1", projectId: "storefront" }] },
      }),
    ]);
    const { container } = render(<Ions client={c} onOpenChat={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show chat" }));
    expect(container.querySelector("aside.tpeek .title")?.textContent).toBe("Fix the cart");
    fireEvent.click(screen.getByRole("button", { name: "Hide chat" }));
    expect(container.querySelector("aside.tpeek")).toBeNull();
  });

  // The user, 2026-11-19: several threads from one message are a line each, no box around them.
  it("shows several threads as a line each", async () => {
    const two = [
      { chatId: "t1", projectId: "storefront" },
      { chatId: "t2", projectId: "storefront" },
    ];
    const c = client([
      ev("ion:chief", EV.ionSaid, { text: "Asked 2 projects.", card: { kind: "threads", threads: two } }),
    ]);
    const { container } = render(<Ions client={c} onOpenChat={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll(".tls .tl")).toHaveLength(2));
    expect(container.querySelector(".fan")).toBeNull();
  });
  // Final review I6: a suggestion you answered stays answered when you come back.
  it("shows a suggestion you already answered as answered", async () => {
    const c = client([
      ev("ion:chief", EV.ionSaid, {
        text: "Always?",
        card: { kind: "suggest", suggestionId: "s1", question: "Use QA?", choice: "Yes" },
      }),
      ev("ion:chief", EV.suggestionAnswered, { suggestionId: "s1", keep: true }),
    ]);
    const { container } = render(<Ions client={c} onOpenChat={() => {}} />);
    await waitFor(() =>
      expect(container.querySelector(".ncard .done")?.textContent).toBe("Always, for this project"),
    );
    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
  });

  // Security scan, 2026-11-24: saving where chats run (or running one on an agent you avoid) waits for your one click
  // in the ion's thread: the question once, Not now or its button (Save, Run), then what you chose.
  it("asks you with one click before saving where chats run", async () => {
    const question = "Save: this project's chats run on Codex?";
    const c = client([
      ev("ion:chief", EV.ionSaid, {
        text: question,
        card: { kind: "confirm", suggestionId: "k1", question, yes: "Save" },
      }),
    ]);
    const { container } = render(<Ions client={c} onOpenChat={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(c.call).toHaveBeenCalledWith("suggestion.answer", { suggestionId: "k1", keep: true });
    await waitFor(() => expect(container.querySelector(".ncard .done")?.textContent).toBe("Saved"));
    expect(container.textContent?.split(question).length).toBe(2);
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  });

  // Final review I9: the ions are read again when something they show changes, not on every word an agent streams.
  it("reads the ions again on ion events, not on streamed text", async () => {
    const live: ((e: IonEvent) => void)[] = [];
    const push = (e: IonEvent) => {
      for (const fn of live) fn(e);
    };
    const c = client();
    vi.mocked(c.subscribe).mockImplementation(async (q: { fromNow?: boolean }, fn: (e: IonEvent) => void) => {
      if (q.fromNow) live.push(fn);
      return () => {};
    });
    render(<Ions client={c} onOpenChat={() => {}} />);
    await waitFor(() => expect(c.call).toHaveBeenCalledWith("ions.list", {}));
    const reads = () => c.call.mock.calls.filter(([cmd]) => cmd === "ions.list").length;
    const before = reads();
    act(() => push(ev("t1", EV.messageDelta, { text: "a" })));
    expect(reads()).toBe(before);
    act(() => push(ev("ion:chief", EV.ionSaid, { text: "x" })));
    await waitFor(() => expect(reads()).toBe(before + 1)); // Task review, 2026-11-19: your message starts the ion's turn, so whether it's thinking is read again too.
    act(() => push(ev("ion:chief", EV.ionHeard, { text: "y" })));
    await waitFor(() => expect(reads()).toBe(before + 2));
  });
  // The lab's Ions panel: Starred, then Other projects, each ion with its star.
  it("groups starred ions first, and stars and unstars a project", async () => {
    const c = client();
    const { container } = render(<Ions client={c} onOpenChat={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll(".ilist .lh")).toHaveLength(2));
    expect([...container.querySelectorAll(".ilist .lh")].map((l) => l.textContent)).toEqual([
      "Starred",
      "Other projects1",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Unstar storefront" }));
    expect(c.call).toHaveBeenCalledWith("project.star", { projectId: "storefront", starred: false });
    fireEvent.click(screen.getByRole("button", { name: "Star payments-api" }));
    expect(c.call).toHaveBeenCalledWith("project.star", { projectId: "payments-api", starred: true });
  });

  // The lab's Ions header: the project picker filters the ions; + adds a project (its ion comes with it).
  it("filters ions by project and adds a project", async () => {
    const c = client();
    const { container } = render(<Ions client={c} onOpenChat={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll(".pmain")).toHaveLength(2));
    fireEvent.click(container.querySelector(".ihead .proj")!);
    fireEvent.click(within(container.querySelector(".ihead .pml") as HTMLElement).getByText("payments-api"));
    expect([...container.querySelectorAll(".pmain b")].map((b) => b.textContent)).toEqual(["payments-api"]);
    fireEvent.click(container.querySelector(".ihead .proj")!);
    fireEvent.click(within(container.querySelector(".ihead .pml") as HTMLElement).getByText("All projects"));
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    const box = screen.getByLabelText("Project name");
    fireEvent.change(box, { target: { value: "billing" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(c.call).toHaveBeenCalledWith("project.create", { name: "billing" });
  });

  // The lab's ion header: the chats the ion started, one click away.
  it("lists the chats an ion started from its header", async () => {
    const onOpenChat = vi.fn();
    const { container } = render(<Ions client={client()} onOpenChat={onOpenChat} />);
    await waitFor(() => expect(container.querySelector(".pmain")).not.toBeNull());
    fireEvent.click(container.querySelector(".pmain")!);
    fireEvent.click(await screen.findByRole("button", { name: "Chats started by storefront" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Fix the cart/ }));
    expect(onOpenChat).toHaveBeenCalledWith("t1");
  });
  // The user, 2026-11-21: "does memory cover todo as well". ion chief's screen shows how many to-dos are open, quietly,
  // and opens them in Settings → Memory; a project's ion doesn't.
  it("shows ion chief's open to-dos and opens them", async () => {
    const c = client();
    const opened = vi.fn();
    window.addEventListener("ion:open-settings", (e) => opened((e as CustomEvent).detail));
    const { container } = render(<Ions client={c} onOpenChat={() => {}} />);
    const todos = await screen.findByRole("button", { name: "2 open to-dos" });
    expect(c.call).toHaveBeenCalledWith("memory.list", { type: "todo", open: true });
    expect(todos.textContent).toBe("2");
    fireEvent.click(todos);
    expect(opened).toHaveBeenCalledWith({ kind: "todos" });
    fireEvent.click(container.querySelector(".pmain")!);
    await screen.findByRole("button", { name: "Chats started by storefront" });
    expect(screen.queryByRole("button", { name: "2 open to-dos" })).toBeNull();
  });

  // The user, 2026-11-19: "ions are not thinking". While an ion decides, its chat shows it's thinking; its reply
  // takes the place.
  it("shows an ion thinking until it replies", async () => {
    const { container } = render(
      <Ions client={client([ev("ion:chief", EV.ionHeard, { text: "hello" })])} onOpenChat={() => {}} />,
    );
    await waitFor(() => expect(container.querySelector(".bcol .pending.now")).not.toBeNull());
    cleanup();
    const replied = client([
      ev("ion:chief", EV.ionHeard, { text: "hello" }),
      ev("ion:chief", EV.ionSaid, { text: "Hi." }),
    ]);
    const after = render(<Ions client={replied} onOpenChat={() => {}} />);
    await waitFor(() => expect(after.container.querySelector(".bi")?.textContent).toBe("Hi."));
    expect(after.container.querySelector(".bcol .pending")).toBeNull();
  });

  // Plan 14 (2026-11-19): an ion thinks as an agent session; its tool calls and thinking show as one work line above
  // its reply ("Worked for 12s"), open to its steps, like a plain chat's.
  it("shows an ion's tool calls as one work line above its reply, open to its steps", async () => {
    const at = (e: IonEvent, ts: string, runId: string | null = "turn1") => ({ ...e, ts, runId }) as IonEvent;
    const events = [
      at(ev("ion:chief", EV.ionHeard, { text: "What's open?" }), "2026-11-18T10:00:00.000Z", null),
      at(ev("ion:chief", EV.thinkingDelta, { text: "Check the needs." }), "2026-11-18T10:00:02.000Z"),
      at(
        ev("ion:chief", EV.toolStarted, { toolId: "x1", kind: "mcp", name: "needs", summary: "storefront" }),
        "2026-11-18T10:00:03.000Z",
      ),
      at(ev("ion:chief", EV.toolFinished, { toolId: "x1", ok: true }), "2026-11-18T10:00:05.000Z"),
      at(ev("ion:chief", EV.ionSaid, { text: "One question." }), "2026-11-18T10:00:12.000Z"),
    ];
    expect(ionTimeline(events).map((i) => i.kind)).toEqual(["you", "ion"]);
    const { container } = render(<Ions client={client(events)} onOpenChat={() => {}} />);
    const head = await screen.findByRole("button", { name: /Worked for 12s/ });
    // The work line sits in the ion's reply, above its words.
    const bm = head.closest(".bm") as HTMLElement;
    expect(bm.querySelector(".work + .bi")?.textContent).toBe("One question.");
    expect(container.querySelectorAll(".work")).toHaveLength(1);
    fireEvent.click(head);
    expect(within(bm).getByText("needs")).toBeTruthy();
    expect(within(bm).getByText("storefront")).toBeTruthy();
    expect(within(bm).getByText("Thought for 1s")).toBeTruthy();
  });

  // Task review, 2026-11-19: a daemon line said mid-turn ("From ion: …", a report) ended the turn's work and took
  // it. Only the turn's own reply (its runId) ends its work and carries it.
  it("keeps an ion's work running through a line said meanwhile, and puts it above its own reply", async () => {
    const at = (e: IonEvent, ts: string, runId: string | null = "turn1") => ({ ...e, ts, runId }) as IonEvent;
    const step = { toolId: "x1", kind: "mcp", name: "needs", summary: "storefront" };
    const live = [
      at(ev("ion:storefront", EV.ionHeard, { text: "What's open?" }), "2026-11-18T10:00:00.000Z", null),
      at(ev("ion:storefront", EV.toolStarted, step), "2026-11-18T10:00:02.000Z"),
      at(
        ev("ion:storefront", EV.ionSaid, { text: "From ion: check the cart" }),
        "2026-11-18T10:00:03.000Z",
        null,
      ),
    ];
    const during = ionTimeline(live);
    expect(during.map((i) => i.kind)).toEqual(["you", "work", "ion"]);
    expect(during[1]?.kind === "work" && during[1].work.ended).toBeUndefined();
    const done = ionTimeline([
      ...live,
      at(ev("ion:storefront", EV.toolFinished, { toolId: "x1", ok: true }), "2026-11-18T10:00:04.000Z"),
      at(ev("ion:storefront", EV.ionSaid, { text: "Nothing open." }), "2026-11-18T10:00:09.000Z"),
    ]);
    expect(done.map((i) => i.kind)).toEqual(["you", "ion", "ion"]);
    const reply = done[2];
    expect(reply?.kind === "ion" && reply.text).toBe("Nothing open.");
    expect(reply?.kind === "ion" && reply.work?.ended).toBe("2026-11-18T10:00:09.000Z");
    expect(done[1]?.kind === "ion" && done[1].work).toBeUndefined();
  });

  // Final review, 2026-11-19: a turn ion stopped mid-way (no reply ever carried its id) stayed "Thinking" forever.
  // Its work ends once your next message, or another turn's line, follows it; a later step of its own reopens it.
  it("ends a turn's work that never got its reply once a later message or turn's line follows", () => {
    const at = (e: IonEvent, ts: string, runId: string | null = "turn1") => ({ ...e, ts, runId }) as IonEvent;
    const step = { toolId: "x1", kind: "mcp", name: "needs", summary: "storefront" };
    const base = [
      at(ev("ion:chief", EV.ionHeard, { text: "What's open?" }), "2026-11-18T10:00:00.000Z", null),
      at(ev("ion:chief", EV.toolStarted, step), "2026-11-18T10:00:02.000Z"),
    ];
    const workOf = (items: ReturnType<typeof ionTimeline>) => items.find((i) => i.kind === "work");
    const heard = at(ev("ion:chief", EV.ionHeard, { text: "Hello?" }), "2026-11-18T11:00:00.000Z", null);
    const w1 = workOf(ionTimeline([...base, heard]));
    expect(w1?.kind === "work" && w1.work.ended).toBe("2026-11-18T11:00:00.000Z");
    const other = at(ev("ion:chief", EV.ionSaid, { text: "Done." }), "2026-11-18T11:00:05.000Z", "turn2");
    const w2 = workOf(ionTimeline([...base, other]));
    expect(w2?.kind === "work" && w2.work.ended).toBe("2026-11-18T11:00:05.000Z");
    // Still running while you wrote: its next step shows it live again.
    const more = at(ev("ion:chief", EV.toolFinished, { toolId: "x1", ok: true }), "2026-11-18T11:00:01.000Z");
    const w3 = workOf(ionTimeline([...base, heard, more]));
    expect(w3?.kind === "work" && w3.work.ended).toBeUndefined();
  });

  it("shows an ion's live work as its current step, not as thinking dots", async () => {
    const events = [
      ev("ion:chief", EV.ionHeard, { text: "What's open?" }),
      {
        ...ev("ion:chief", EV.toolStarted, {
          toolId: "x1",
          kind: "mcp",
          name: "needs",
          summary: "storefront",
        }),
        runId: "turn1",
      } as IonEvent,
    ];
    const { container } = render(<Ions client={client(events)} onOpenChat={() => {}} />);
    await waitFor(() =>
      expect(container.querySelector(".work .wh .now")?.textContent).toBe("needs storefront"),
    );
    expect(container.querySelector(".bcol .pending")).toBeNull();
  });
});
