import { describe, expect, it } from "vitest";
import { blockedAnswer, blockedQuestion } from "./blocked.js";

// The user, 2026-11-21: a guess (a script ion can't read, decoded text that runs) asks you instead of refusing; the
// question says ion is wary, not that it stopped the call.
describe("blockedQuestion", () => {
  const b = { requestId: "q", summary: "./main", reason: "it runs a file this command creates", key: "k" };
  it("says ion stopped it when the judge said no", () => {
    expect(blockedQuestion(b).why).toBe("ion stopped it: it runs a file this command creates");
  });
  it("says ion is wary of it for a guess", () => {
    expect(blockedQuestion({ ...b, wary: true }).why).toBe(
      "ion is wary of this: it runs a file this command creates",
    );
  });

  // Tour, final review, 2026-11-21: the question showed raw JSON after the reason ("…it runs a file this command
  // creates { "command": … }"). The command is the question's title; only the reason follows it.
  it("shows only the reason when the input is just the command in the title", () => {
    const input = JSON.stringify({ command: "./main", description: "Run it" }, null, 2);
    expect(blockedQuestion({ ...b, wary: true, input }).why).toBe(
      "ion is wary of this: it runs a file this command creates",
    );
    expect(blockedQuestion({ ...b, input }).why).toBe("ion stopped it: it runs a file this command creates");
  });
  it("still shows an input that says more than the title (an edit's text, a cut one)", () => {
    const input = JSON.stringify({ file_path: "a.ts", content: "x" }, null, 2);
    expect(blockedQuestion({ ...b, summary: "Edit a.ts", input }).why).toContain('"content": "x"');
    const bg = JSON.stringify({ command: "./main", run_in_background: true }, null, 2);
    expect(blockedQuestion({ ...b, input: bg }).why).toContain("run_in_background");
    const cut = '{\n  "command": "./main …\n… (cut)';
    expect(blockedQuestion({ ...b, input: cut, cut: true }).why).toContain("(cut)");
  });
});

// Ruling, 2026-11-21: a repo's server that runs the repo's own code is asked about in each chat.
describe("a repo's server, asked in the chat", () => {
  it("says what wants to run, and offers Allow for this chat or No", () => {
    const q = blockedQuestion({
      requestId: "repo1",
      summary: "shop's .mcp.json wants to run local from the repo",
      reason: "node ./tools/mcp.js",
      key: "repo shop local",
      repo: true,
    });
    expect(q.question).toBe("shop's .mcp.json wants to run local from the repo");
    expect(q.choices.map((c) => c.label)).toEqual(["Allow for this chat", "No"]);
    expect(blockedAnswer("Allow for this chat", false)).toEqual({ allow: true, scope: null });
    expect(blockedAnswer("No", false)).toEqual({ allow: false, scope: "chat" });
  });
});
