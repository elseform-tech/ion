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

describe("QuestionBar", () => {
  it("answers with the choice's number, for this project when ticked", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    render(<QuestionBar client={{ call } as unknown as IonClient} question={question} />);
    fireEvent.click(screen.getByLabelText("Always for this project"));
    fireEvent.click(screen.getByRole("button", { name: /Wait/ }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("need.answer", { needId: "n1", choice: 2, scope: "project" }),
    );
  });

  // Review Focus 4: answered elsewhere (the CLI) first.
  it("shows ion's refusal, and nothing once the question is answered", async () => {
    const call = vi.fn(async () => {
      throw new ApiCallError("invalid", "That's already answered");
    });
    const { rerender, container } = render(
      <QuestionBar client={{ call } as unknown as IonClient} question={question} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Merge/ }));
    expect(await screen.findByText("That's already answered")).toBeTruthy();
    rerender(
      <QuestionBar client={{ call } as unknown as IonClient} question={{ ...question, answered: "Merge" }} />,
    );
    expect(container.textContent).toBe("");
  });
});
