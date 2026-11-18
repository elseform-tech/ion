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
      <QuestionBar
        client={{ call } as unknown as IonClient}
        question={{ ...question, resolved: true, answered: "Merge" }}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("sends your own words when none of the choices fit", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    render(<QuestionBar client={{ call } as unknown as IonClient} question={question} />);
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

  it("shows the question first, then each option with its reasoning, and the recommended one marked", () => {
    const rich = {
      ...question,
      choices: [
        { label: "Merge", consequence: "main gets it today; CI is green", recommended: true },
        { label: "Wait", consequence: "Nothing changes until the review" },
      ],
    };
    const { container } = render(
      <QuestionBar client={{ call: vi.fn() } as unknown as IonClient} question={rich} />,
    );
    expect(container.querySelector(".qcard-q")?.textContent).toBe("Merge it?");
    expect(container.querySelector(".qcard-why")?.textContent).toBe("Tests pass");
    const options = [...container.querySelectorAll(".qcard-option")].map((o) => o.textContent);
    expect(options).toEqual([
      "MergeRecommendedmain gets it today; CI is green",
      "WaitNothing changes until the review",
    ]);
  });

  it("for a call ion stopped, has no 'always' box (its options say it) and says when ion went on without it", () => {
    const { container, queryByLabelText } = render(
      <QuestionBar
        client={{ call: vi.fn() } as unknown as IonClient}
        question={{ ...question, blocked: true, expired: true }}
      />,
    );
    expect(queryByLabelText("Always for this project")).toBeNull();
    expect(container.querySelector(".qcard-expired")?.textContent).toBe(
      "ion said no after 4 minutes, and the agent went on. Your answer still counts.",
    );
  });
});
