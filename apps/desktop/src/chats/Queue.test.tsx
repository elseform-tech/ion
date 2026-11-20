// @vitest-environment jsdom
import { ApiCallError, type IonClient } from "@ion/client/browser";
import { EV, type HarnessInfo, type QueuedInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.js";

afterEach(cleanup);

const fake: HarnessInfo = {
  id: "fake",
  label: "Fake",
  installed: true,
  signedIn: true,
  models: [],
  defaultModel: null,
};

const queued = (queueId: string, text: string, more: Partial<QueuedInfo> = {}): QueuedInfo => ({
  queueId,
  text,
  brain: { harness: "fake" },
  addedAt: "2026-11-19T10:00:00.000Z",
  ...more,
});

/** A daemon with this queue for chat c1; `refuse`: the command it says no to, and why. */
function daemon(items: QueuedInfo[] = [], refuse?: [string, string]) {
  const call = vi.fn(async (cmd: string, _a?: unknown): Promise<unknown> => {
    if (refuse && cmd === refuse[0]) throw new ApiCallError("invalid", refuse[1]);
    if (cmd === "queue.list") return items;
    if (cmd === "queue.add") return { queueId: "q9" };
    if (cmd === "queue.take") return { text: "edit me" };
    if (cmd === "ask") return { chatId: "c1", runId: "r2" };
    return { ok: true };
  });
  const subscribe = vi.fn(async () => () => {});
  return { call, subscribe };
}

function chatBox(d: ReturnType<typeof daemon>, running: string | null) {
  return render(
    <Composer
      client={d as unknown as IonClient}
      harnesses={[fake]}
      to={{ chatId: "c1" }}
      running={running}
      harness="fake"
      onSent={() => {}}
    />,
  );
}

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });

describe("the queue in a chat", () => {
  // The user, 2026-11-19: "enter for queue when the thread is still running". Enter queues while the agent works,
  // and sends as before when it doesn't.
  it("Enter queues while the agent works, and sends when it doesn't", async () => {
    const d = daemon();
    const { rerender } = chatBox(d, "r1");
    type("next, the tests");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("");
    await waitFor(() =>
      expect(d.call).toHaveBeenCalledWith("queue.add", {
        to: { chatId: "c1" },
        text: "next, the tests",
        brain: {},
      }),
    );
    expect(d.call).not.toHaveBeenCalledWith("ask", expect.anything());
    rerender(
      <Composer
        client={d as unknown as IonClient}
        harnesses={[fake]}
        to={{ chatId: "c1" }}
        running={null}
        harness="fake"
        onSent={() => {}}
      />,
    );
    type("now this");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() =>
      expect(d.call).toHaveBeenCalledWith("ask", {
        text: "now this",
        chatId: "c1",
        harness: "fake",
      }),
    );
  });

  // The user, 2026-11-19: "command + enter for push right now". ⌘Enter while the agent works sends it now.
  it("⌘Enter sends now", async () => {
    const d = daemon();
    chatBox(d, "r1");
    type("stop, do this instead");
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(d.call).toHaveBeenCalledWith("queue.sendNow", { queueId: "q9" }));
    expect(d.call).toHaveBeenCalledWith(
      "queue.add",
      expect.objectContaining({ text: "stop, do this instead" }),
    );
  });

  // The user, 2026-11-19: "with push now icon, edit icon, remove icon". Each line has the three; Edit puts its text
  // back in the box (after what's there).
  it("each queued line has Send now, Edit and Remove; Edit puts the text back in the box", async () => {
    const d = daemon([queued("q1", "first"), queued("q2", "second")]);
    chatBox(d, "r1");
    const lines = await screen.findAllByRole("listitem");
    expect(lines.map((l) => l.textContent)).toEqual(["first", "second"]);
    const first = within(lines[0]!);
    fireEvent.click(first.getByRole("button", { name: "Send now" }));
    expect(d.call).toHaveBeenCalledWith("queue.sendNow", { queueId: "q1" });
    fireEvent.click(first.getByRole("button", { name: "Remove" }));
    expect(d.call).toHaveBeenCalledWith("queue.remove", { queueId: "q1" });
    type("mine");
    fireEvent.click(within(lines[1]!).getByRole("button", { name: "Edit" }));
    expect(d.call).toHaveBeenCalledWith("queue.take", { queueId: "q2" });
    await waitFor(() => expect(box().value).toBe("mine\nedit me"));
  });

  // The user, 2026-11-19: a queued message that couldn't go out says why.
  it("a failed one says why", async () => {
    chatBox(daemon([queued("q1", "first", { why: "Claude Code isn't signed in" })]), "r1");
    const line = await screen.findByRole("listitem");
    expect(line.textContent).toContain("Claude Code isn't signed in");
  });

  // The user, 2026-11-19: a queued message waits while the agent's question is open, and says so.
  it("a held one says it waits for your answer", async () => {
    chatBox(daemon([queued("q1", "first", { held: "answer" })]), "r1");
    const line = await screen.findByRole("listitem");
    expect(line.textContent).toContain("After your answer");
  });

  // Plan 16: at most 10 wait; the daemon's refusal shows under the box and your words come back.
  it("shows the daemon's refusal and puts your words back", async () => {
    chatBox(daemon([], ["queue.add", "That's 10 waiting already"]), "r1");
    type("one more");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(await screen.findByText("That's 10 waiting already")).toBeTruthy();
    expect(box().value).toBe("one more");
  });

  // Task review, 2026-11-19: a refusal stayed under the box after you went on typing and sending.
  it("drops the refusal once you change the box", async () => {
    chatBox(daemon([], ["queue.add", "That's 10 waiting already"]), "r1");
    type("one more");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(await screen.findByText("That's 10 waiting already")).toBeTruthy();
    type("one more, shorter");
    expect(screen.queryByText("That's 10 waiting already")).toBeNull();
  });

  // Task review, 2026-11-19: after Edit you had to click into the box to go on.
  it("puts the caret at the end of the box after Edit", async () => {
    chatBox(daemon([queued("q1", "first")]), "r1");
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await waitFor(() => expect(box().value).toBe("edit me"));
    await waitFor(() => expect(document.activeElement).toBe(box()));
    expect(box().selectionStart).toBe("edit me".length);
  });

  // Task review, 2026-11-19: Enter that picks a word in an input method (keyCode 229) isn't a send.
  it("leaves Enter alone while an input method composes", () => {
    const d = daemon();
    chatBox(d, "r1");
    type("日本");
    fireEvent.keyDown(box(), { key: "Enter", keyCode: 229 });
    expect(box().value).toBe("日本");
    expect(d.call).not.toHaveBeenCalledWith("queue.add", expect.anything());
  });

  // Task review, 2026-11-19: each box listens only to its own chat's events.
  it("listens only to its own chat", async () => {
    const d = daemon();
    chatBox(d, "r1");
    await waitFor(() =>
      expect(d.subscribe).toHaveBeenCalledWith({ chatId: "c1", fromNow: true }, expect.anything()),
    );
  });

  // Final review, 2026-11-19: "After your answer" showed (and went) only when the queue next changed. The queue is
  // read again when the agent asks something or the question is answered.
  it("reads the queue again when a question is raised or answered", async () => {
    const d = daemon();
    let push: (e: { type: string }) => void = () => {};
    d.subscribe.mockImplementation((async (_q: unknown, fn: (e: { type: string }) => void) => {
      push = fn;
      return () => {};
    }) as never);
    chatBox(d, "r1");
    const reads = () => d.call.mock.calls.filter(([cmd]) => cmd === "queue.list").length;
    await waitFor(() => expect(reads()).toBe(1));
    push({ type: EV.needRaised });
    await waitFor(() => expect(reads()).toBe(2));
    push({ type: EV.needResolved });
    await waitFor(() => expect(reads()).toBe(3));
  });

  // Final review, 2026-11-19: queued while the chat's own agent was signed out, a message switched to the first
  // ready agent (maybe Claude Code) and went out on it later, unattended. Queued, it keeps the chat's own agent
  // (ion says why if it still can't go).
  it("a queued message keeps the chat's own agent", async () => {
    const grok: HarnessInfo = { ...fake, id: "grok-build", label: "Grok Build" };
    const out: HarnessInfo = { ...fake, id: "claude-code", label: "Claude Code", signedIn: false };
    const d = daemon();
    render(
      <Composer
        client={d as unknown as IonClient}
        harnesses={[out, grok]}
        to={{ chatId: "c1" }}
        running="r1"
        harness="claude-code"
        current={{ model: "opus", effort: "" }}
        onSent={() => {}}
      />,
    );
    type("later");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() =>
      expect(d.call).toHaveBeenCalledWith("queue.add", {
        to: { chatId: "c1" },
        text: "later",
        brain: { model: "opus" },
      }),
    );
  });

  // Tour, 2026-11-19: a chat on an agent the app doesn't list (the fake one) showed "Claude Code" and its queued
  // follow-up ran on Claude Code. It keeps its own agent: shown by name, and nothing sent overrides it.
  it("keeps a chat on an unlisted agent on its own agent", async () => {
    const grok: HarnessInfo = { ...fake, id: "grok-build", label: "Grok Build" };
    const d = daemon();
    const at = (running: string | null) => (
      <Composer
        client={d as unknown as IonClient}
        harnesses={[grok]}
        to={{ chatId: "c1" }}
        running={running}
        harness="fake"
        onSent={() => {}}
      />
    );
    const { rerender } = render(at("r1"));
    expect(screen.getByRole("button", { name: /Harness, model and effort/ }).textContent).toContain("fake");
    type("then this");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() =>
      expect(d.call).toHaveBeenCalledWith("queue.add", {
        to: { chatId: "c1" },
        text: "then this",
        brain: {},
      }),
    );
    rerender(at(null));
    type("and this");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(d.call).toHaveBeenCalledWith("ask", { text: "and this", chatId: "c1" }));
  });
});
