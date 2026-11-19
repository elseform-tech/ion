// @vitest-environment jsdom
import { ApiCallError, type IonClient } from "@ion/client/browser";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionBar } from "./QuestionBar.js";
import type { Item } from "./timeline.js";

afterEach(cleanup);

const question: Extract<Item, { kind: "question" }> = {
  kind: "question",
  needId: "n1",
  question: "Merge it?",
  why: "Tests pass",
  choices: [
    { label: "Merge", consequence: "main gets the change" },
    { label: "Wait", consequence: "Nothing yet" },
  ],
};

const bar = (
  q: Extract<Item, { kind: "question" }> = question,
  call = vi.fn(async () => ({ ok: true })),
) => ({
  call,
  ...render(<QuestionBar client={{ call } as unknown as IonClient} question={q} />),
});
const collapse = () => fireEvent.click(screen.getByRole("button", { name: "Collapse" }));

describe("QuestionBar", () => {
  // The user, 2026-11-18: the question opens expanded above the message box: why, each option with its reasoning,
  // your own words and Always.
  it("opens expanded: the question, why, each option with its reasoning, your own words and Always", () => {
    const { container } = bar();
    expect(container.querySelector(".qbox .qq")?.textContent).toBe("Merge it?");
    expect(container.querySelector(".qbox .why")?.textContent).toBe("Tests pass");
    expect([...container.querySelectorAll(".qbox .qopt")].map((r) => r.textContent)).toEqual([
      "Mergemain gets the change",
      "WaitNothing yet",
    ]);
    expect(screen.getByLabelText("Your own answer")).toBeTruthy();
    expect(screen.getByLabelText("Always for this project")).toBeTruthy();
  });

  it("collapses to one line: the question and a button per option, the recommended one primary", () => {
    const rec = {
      ...question,
      choices: [{ ...question.choices[0]!, recommended: true }, question.choices[1]!],
    };
    const { container } = bar(rec);
    collapse();
    expect(container.querySelector(".qbox .qq")?.textContent).toBe("Merge it?");
    const btns = [...container.querySelectorAll(".qhead > .btn")];
    expect(btns.map((b) => b.textContent)).toEqual(["Merge", "Wait"]);
    expect(btns[0]!.classList.contains("pri")).toBe(true);
    expect(screen.queryByLabelText("Your own answer")).toBeNull();
  });

  it("answers with the choice's number, for this project when ticked", async () => {
    const { call } = bar();
    fireEvent.click(screen.getByLabelText("Always for this project"));
    fireEvent.click(screen.getByRole("button", { name: /^Wait/ }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("need.answer", { needId: "n1", choice: 2, scope: "project" }),
    );
  });

  // Review Focus 4: answered elsewhere (the CLI) first.
  it("shows ion's refusal, and nothing once the question is answered", async () => {
    const call = vi.fn(async () => {
      throw new ApiCallError("invalid", "That's already answered");
    });
    const { rerender, container } = bar(question, call);
    fireEvent.click(screen.getByRole("button", { name: /^Merge/ }));
    expect(await screen.findByText("That's already answered")).toBeTruthy();
    rerender(
      <QuestionBar
        client={{ call } as unknown as IonClient}
        question={{ ...question, resolved: true, answered: "Merge" }}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("sends your own words when none of the choices fit", async () => {
    const { call } = bar();
    const box = screen.getByLabelText("Your own answer");
    fireEvent.change(box, { target: { value: "Merge tomorrow" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("need.answer", {
        needId: "n1",
        text: "Merge tomorrow",
        scope: "chat",
      }),
    );
  });

  // A quiet chat: a call ion stopped has no Always (its options say it) and no banner once ion went on.
  it("for a call ion stopped, has no Always and no expired banner", () => {
    const { container } = bar({ ...question, blocked: true, expired: true });
    expect(screen.queryByLabelText("Always for this project")).toBeNull();
    expect(container.textContent).not.toContain("4 minutes");
  });
  // Final review I3: the bar stays one line: the question truncates (all of it on hover), at most two buttons
  // (the recommended one always among them); the rest are in the details.
  it("keeps to one line with many options: two buttons on the bar, the recommended one kept", () => {
    const many = {
      ...question,
      question: "Which of these four ways should I use to fix the flaky checkout test?",
      choices: ["A", "B", "C", "D"].map((label) => ({
        label,
        consequence: label,
        recommended: label === "D",
      })),
    };
    const { container } = bar(many);
    collapse();
    expect(container.querySelector(".qhead .qq")?.getAttribute("title")).toBe(many.question);
    expect([...container.querySelectorAll(".qhead > .btn")].map((b) => b.textContent)).toEqual(["A", "D"]);
  });
  // Security review: on ion's question about a call it stopped, every option (no) stays on the bar.
  it("shows every option on the bar for a call ion stopped", () => {
    const stopped = {
      ...question,
      blocked: true,
      choices: ["Allow once", "Always allow", "Keep it blocked"].map((label, n) => ({
        label,
        consequence: label,
        recommended: n === 1,
      })),
    };
    const { container } = bar(stopped);
    collapse();
    expect([...container.querySelectorAll(".qhead > .btn")].map((b) => b.textContent)).toEqual([
      "Allow once",
      "Always allow",
      "Keep it blocked",
    ]);
  });
  // Plan 09: a question from an ion thread carries its ion's note.
  it("shows the ion's note under the question", () => {
    const { container } = bar({ ...question, note: "storefront's ion: first time this comes up" });
    expect(container.querySelector(".qbox .qnote")?.textContent).toBe(
      "storefront's ion: first time this comes up",
    );
  });

  // The user, 2026-11-19: a cleaner box that doesn't crowd the chat: options one line each, the hint at most 3
  // lines (all of it on a click), and your own answer with Always on one row.
  it("keeps the hint to 3 lines until you open it, and each option to one line", () => {
    const long = { ...question, why: "A long reason. ".repeat(40) };
    const { container } = bar(long);
    const why = container.querySelector<HTMLElement>(".qbox .why")!;
    expect(why.classList.contains("clamp")).toBe(true);
    fireEvent.click(why);
    expect(why.classList.contains("clamp")).toBe(false);
    expect(container.querySelectorAll(".qopt b")).toHaveLength(2);
    expect(container.querySelector(".qd-f")?.textContent).toContain("Always");
  });
});
