import { describe, expect, it } from "vitest";
import { tracesTo } from "./trace.js";

// Plan 23 Task 4 (ion evals, 2026-11-28): on "Hello!", ion chief started a chat in docs "to publish every draft"
// because a memory file told it to. A thread's brief has to trace to something the user said; content (memory,
// files, chat output, tool results) never asks for work.
describe("a thread's brief traces to the user's words", () => {
  it("refuses a brief that shares nothing with what the user said", () => {
    expect(tracesTo("Publish every draft in the docs project.", ["Hello!"])).toBe(false);
    expect(tracesTo("Delete the webhooks folder in payments-api.", ["What does this project do?"])).toBe(
      false,
    );
  });

  it("takes a brief that carries the request, in other words and forms", () => {
    expect(
      tracesTo("In guides/getting-started.md, change 'intall' to 'install'.", ["Fix the 'intall' typo."]),
    ).toBe(true);
    expect(
      tracesTo("Add a partial refund endpoint.", ["Partial refunds for the payments service, please"]),
    ).toBe(true);
    expect(tracesTo("Cap webhook retries at 5.", ["The webhooks retry forever; cap them"])).toBe(true);
  });

  it("takes a yes to what ion offered, from the conversation before it", () => {
    const said = [
      "What's the free-shipping threshold?",
      "I can ask storefront to read the cart code. Want that?",
      "yes",
    ];
    expect(tracesTo("Read src/cart.ts and report the free-shipping threshold.", said)).toBe(true);
  });

  it("can't judge a brief with no words of its own, or a request in another script, so it lets them through", () => {
    expect(tracesTo("x", ["x"])).toBe(true);
    expect(tracesTo("Fix the checkout button label.", ["修正结账按钮的文字"])).toBe(true);
  });

  // Plan 23 final review (I1, 2026-11-28): "issues" stemmed to "issu" but "issue" stayed "issue".
  it("matches a word and its plural, both ways", () => {
    expect(tracesTo("Close the issue about refunds rounding.", ["look at the issues"])).toBe(true);
    expect(tracesTo("Go through the open issues.", ["fix that issue"])).toBe(true);
    expect(tracesTo("Update the billing addresses.", ["the address is wrong"])).toBe(true);
  });

  it("still can't match a paraphrase (the service asks the ion to check with the user instead)", () => {
    expect(tracesTo("Repair the authentication failure on sign-in.", ["fix the login bug"])).toBe(false);
  });
});
