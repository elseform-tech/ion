// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import { EV, type IonEvent, type IonInfo, type QueuedInfo } from "@ion/schema";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IonChat } from "./IonChat.js";

afterEach(cleanup);

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, runId: string | null = null): IonEvent =>
  ({
    v: 1,
    id: `e${++seq}`,
    chatId: "ion:storefront",
    runId,
    seq,
    ts: "2026-11-19T10:00:00.000Z",
    origin: "daemon",
    type,
    data,
  }) as IonEvent;

const ion: IonInfo = {
  ionId: "storefront",
  name: "storefront",
  color: null,
  harness: "opencode",
  last: null,
  needs: 0,
  working: false,
  thinking: false,
  starred: false,
};

/** A daemon with this ion chat (its events) and its queue; the ion chat's listener, to add events live. */
function daemon(events: IonEvent[], items: QueuedInfo[] = []) {
  let push: (e: IonEvent) => void = () => {};
  const call = vi.fn(async (cmd: string, _a?: unknown): Promise<unknown> => {
    if (cmd === "queue.list") return items;
    if (cmd === "queue.add") return { queueId: "q9" };
    if (cmd === "queue.take") return { text: "edit me" };
    if (cmd === "ion.stop") {
      push(ev(EV.ionSaid, { text: "Stopped." }, "turn1"));
      return { ok: true, stopped: true };
    }
    return { ok: true };
  });
  const subscribe = vi.fn(async (q: { chatId?: string; fromNow?: boolean }, fn: (e: IonEvent) => void) => {
    if (q.chatId && !q.fromNow) {
      push = (e) => act(() => fn(e));
      for (const e of events) fn(e);
    }
    return () => {};
  });
  return { call, subscribe };
}

/** The ion's chat; `thinking`: what ion says of its turn (the daemon's word, not a guess from the chat). */
const show = (d: ReturnType<typeof daemon>, thinking = true) =>
  render(
    <IonChat
      client={d as unknown as IonClient}
      ion={{ ...ion, thinking }}
      ions={[ion]}
      chats={[]}
      needs={[]}
      onOpenChat={() => {}}
    />,
  );

const box = () => screen.getByLabelText("Message storefront") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const thinking = [
  ev(EV.ionHeard, { text: "Fix the cart" }),
  ev(EV.thinkingDelta, { text: "Looking" }, "turn1"),
];

describe("an ion's message box", () => {
  // The user, 2026-11-19: "there is no stop (double esc) for both plain chat and ions". Esc twice stops the ion's
  // turn, and its chat says it stopped.
  it("Esc twice stops an ion's turn, and it says it stopped", async () => {
    const d = daemon(thinking);
    show(d);
    await screen.findByLabelText("Message storefront");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(d.call).not.toHaveBeenCalledWith("ion.stop", expect.anything());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(d.call).toHaveBeenCalledWith("ion.stop", { ionId: "storefront" });
    expect(await screen.findByText("Stopped.")).toBeTruthy();
  });

  // The user, 2026-11-19: "even for ions, maybe?". Enter queues while the ion thinks; ⌘Enter sends it now; when
  // it's done, Enter sends as before.
  it("Enter queues while the ion thinks, ⌘Enter sends now, and Enter sends when it's done", async () => {
    const d = daemon(thinking);
    show(d);
    type("then the tests");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("");
    await waitFor(() =>
      expect(d.call).toHaveBeenCalledWith("queue.add", {
        to: { ionId: "storefront" },
        text: "then the tests",
        brain: {},
      }),
    );
    type("this first");
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(d.call).toHaveBeenCalledWith("queue.sendNow", { queueId: "q9" }));
    expect(d.call).not.toHaveBeenCalledWith("ion.message", expect.anything());
    cleanup();
    const idle = daemon([ev(EV.ionHeard, { text: "hi" }), ev(EV.ionSaid, { text: "Hello." }, "turn1")]);
    show(idle, false);
    type("thanks");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(idle.call).toHaveBeenCalledWith("ion.message", {
      ionId: "storefront",
      text: "thanks",
    });
  });

  // The user, 2026-11-19: "with push now icon, edit icon, remove icon", for an ion's queue too.
  it("each queued line has Send now, Edit and Remove; Edit puts the text back in the box", async () => {
    const d = daemon(thinking, [
      { queueId: "q1", text: "first", brain: {}, addedAt: "" },
      { queueId: "q2", text: "second", brain: {}, addedAt: "" },
    ]);
    show(d);
    const lines = await screen.findAllByRole("listitem");
    expect(lines.map((l) => l.textContent)).toEqual(["first", "second"]);
    fireEvent.click(within(lines[0]!).getByRole("button", { name: "Send now" }));
    expect(d.call).toHaveBeenCalledWith("queue.sendNow", { queueId: "q1" });
    fireEvent.click(within(lines[0]!).getByRole("button", { name: "Remove" }));
    expect(d.call).toHaveBeenCalledWith("queue.remove", { queueId: "q1" });
    fireEvent.click(within(lines[1]!).getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(box().value).toBe("edit me"));
  });

  // Task review, 2026-11-19: the box guessed from the chat whether the ion was thinking; after a restart or in a
  // report turn it guessed wrong. It goes by what ion says.
  it("queues and stops by what ion says, not by what its chat looks like", async () => {
    const quiet = daemon([ev(EV.ionHeard, { text: "hi" }), ev(EV.ionSaid, { text: "Hello." }, "turn1")]);
    show(quiet, true);
    type("next");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(quiet.call).toHaveBeenCalledWith("queue.add", expect.anything()));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(quiet.call).toHaveBeenCalledWith("ion.stop", { ionId: "storefront" });
    cleanup();
    const after = daemon([ev(EV.ionHeard, { text: "hi" })]);
    show(after, false);
    type("again");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(after.call).toHaveBeenCalledWith("ion.message", { ionId: "storefront", text: "again" });
  });

  // Task review, 2026-11-19: the Send button sent straight to a thinking ion, past the queue.
  it("Send queues while the ion thinks", async () => {
    const d = daemon(thinking);
    show(d);
    type("later");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(d.call).toHaveBeenCalledWith("queue.add", expect.anything()));
    expect(d.call).not.toHaveBeenCalledWith("ion.message", expect.anything());
  });

  // Task review, 2026-11-19: after Edit you had to click into the box to go on.
  it("puts the caret at the end of the box after Edit", async () => {
    show(daemon(thinking, [{ queueId: "q1", text: "first", brain: {}, addedAt: "" }]));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await waitFor(() => expect(box().value).toBe("edit me"));
    await waitFor(() => expect(document.activeElement).toBe(box()));
    expect(box().selectionStart).toBe("edit me".length);
  });
});
