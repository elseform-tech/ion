// @vitest-environment jsdom
import type { IonClient } from "@ion/client/browser";
import type { HarnessInfo } from "@ion/schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.js";
import { PickedText } from "./PickChips.js";

afterEach(cleanup);

// The user, 2026-11-22: a skill or command you pick is a chip in the sentence, where you typed it ("use [review] on
// this, then [plan]"), not a row of its own; any number of them, Backspace removes one, and the message keeps their
// order: its text with each pick in place ("/review"), and the names as before.
const fake: HarnessInfo = {
  id: "fake",
  label: "Fake",
  installed: true,
  signedIn: true,
  models: [],
  defaultModel: null,
};
const picks = {
  skills: [
    { name: "review", description: "Review the diff", kind: "command", from: "own" },
    { name: "plan", description: "Make a plan", kind: "skill", from: "own" },
  ],
  servers: [{ name: "everything", description: "", kind: "server", from: "ion" }],
};

function setup() {
  const call = vi.fn(async (cmd: string) => {
    if (cmd === "tools.picks") return picks;
    return cmd === "queue.list" ? [] : { chatId: "c1", runId: "r1" };
  });
  const client = { call, subscribe: async () => () => {} } as unknown as IonClient;
  render(
    <Composer
      client={client}
      harnesses={[fake]}
      to={{ chatId: "c1" }}
      harness="fake"
      running={null}
      onSent={() => {}}
    />,
  );
  return { call, box: screen.getByLabelText("Message") as HTMLTextAreaElement };
}

/** Types `text` into the box with the caret at its end. */
const type = (box: HTMLTextAreaElement, text: string) =>
  fireEvent.change(box, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });

/** The chips drawn in the box, in order, with the words around them. */
const drawn = () =>
  [...(document.querySelector(".cmirror")?.childNodes ?? [])].map((n) =>
    n instanceof HTMLElement ? `[${n.textContent}]` : n.textContent,
  );

async function pick(box: HTMLTextAreaElement, text: string) {
  type(box, text);
  await screen.findByRole("listbox");
  fireEvent.keyDown(box, { key: "Enter" });
}

describe("picks in the sentence", () => {
  it("two picks keep their places and order in the text and the names", async () => {
    const { call, box } = setup();
    await pick(box, "use /rev");
    expect(box.value).toBe("use /review ");
    await pick(box, "use /review on this, then /pl");
    expect(box.value).toBe("use /review on this, then /plan ");
    expect(drawn().join("")).toBe("use [/review] on this, then [/plan] ​");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "ask",
        expect.objectContaining({ text: "use /review on this, then /plan ", skills: ["review", "plan"] }),
      ),
    );
  });

  it("a pick placed before another comes first in the names", async () => {
    const { call, box } = setup();
    await pick(box, "then /pl");
    fireEvent.change(box, { target: { value: "/rev then /plan ", selectionStart: 4, selectionEnd: 4 } });
    await screen.findByRole("listbox");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("/review then /plan ");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("ask", expect.objectContaining({ skills: ["review", "plan"] })),
    );
  });

  it("Backspace right after a chip removes it whole", async () => {
    const { call, box } = setup();
    await pick(box, "use /rev");
    type(box, "use /review now");
    box.setSelectionRange(11, 11);
    fireEvent.keyDown(box, { key: "Backspace" });
    expect(box.value).toBe("use  now");
    expect(document.querySelector(".cmirror")).toBeNull();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("ask", expect.objectContaining({ text: "use  now" })),
    );
    expect(call).not.toHaveBeenCalledWith("ask", expect.objectContaining({ skills: expect.anything() }));
  });

  it("arrow keys step over a chip as one", async () => {
    const { box } = setup();
    await pick(box, "use /rev");
    box.setSelectionRange(11, 11);
    fireEvent.keyDown(box, { key: "ArrowLeft" });
    expect(box.selectionStart).toBe(4);
    fireEvent.keyDown(box, { key: "ArrowRight" });
    expect(box.selectionStart).toBe(11);
  });

  it("the box stays a text field, its picks named for screen readers", async () => {
    const { box } = setup();
    await pick(box, "use /rev");
    expect(box.tagName).toBe("TEXTAREA");
    const named = document.getElementById(box.getAttribute("aria-describedby") ?? "");
    expect(named?.textContent).toBe("Command: review");
  });
});

describe("a sent message's picks", () => {
  it("are chips in its text, in place; one not in the text stays above it", () => {
    render(
      <div className="u">
        <PickedText
          text="use /review on this, then /plan"
          picked={{ skills: ["review", "plan", "old"], mentions: ["everything"] }}
        />
      </div>,
    );
    const chips = [...document.querySelectorAll(".chip.inl")];
    expect(chips.map((c) => [c.textContent, c.getAttribute("aria-label")])).toEqual([
      ["/review", "Skill: review"],
      ["/plan", "Skill: plan"],
    ]);
    expect(document.querySelector(".u")?.textContent).toContain("use /review on this, then /plan");
    expect(screen.getByText("old").closest(".catt")).not.toBeNull();
    expect(screen.getByText("everything").closest(".catt")).not.toBeNull();
  });
});
