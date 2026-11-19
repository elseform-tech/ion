// @vitest-environment jsdom
import { ApiCallError, type IonClient } from "@ion/client/browser";
import type { HarnessInfo, QueuedInfo } from "@ion/schema";
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
        brain: { harness: "fake" },
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
});
