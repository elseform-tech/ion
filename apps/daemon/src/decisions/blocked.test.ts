import { describe, expect, it } from "vitest";
import { blockedAnswer, blockedQuestion } from "./blocked.js";

// The user, 2026-11-21: a guess (a script ion can't read, decoded text that runs) asks you instead of refusing; the
// question says ion is wary, not that it stopped the call.
describe("blockedQuestion", () => {
  const b = { requestId: "q", summary: "./main", reason: "it runs a file this command creates", key: "k" };
  // The user, 2026-11-21: the question says why in plain words: risky, or not sure.
  it("says ion thinks it's risky when the judge said no, and that it isn't sure when the judge was unsure", () => {
    expect(blockedQuestion(b).why).toBe("ion thinks this is risky: it runs a file this command creates");
    expect(blockedQuestion({ ...b, unsure: true }).why).toBe(
      "ion isn't sure: it runs a file this command creates",
    );
  });
  // Task review, 2026-11-21: a judge that couldn't decide isn't "risky".
  it("says ion couldn't decide when the judge gave no verdict", () => {
    expect(blockedQuestion({ ...b, undecided: true, reason: "ion couldn't decide in time" }).why).toBe(
      "ion couldn't decide: ion couldn't decide in time",
    );
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
    expect(blockedQuestion({ ...b, input }).why).toBe(
      "ion thinks this is risky: it runs a file this command creates",
    );
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
    expect(blockedAnswer("Allow for this chat", false)).toMatchObject({ allow: true, scope: null });
    expect(blockedAnswer("No", false)).toMatchObject({ allow: false, scope: "chat" });
  });
});

// Task review, 2026-11-21: the command a repo wrote is shown as text: control characters stripped, and capped.
describe("a repo's server's command in the question", () => {
  it("is stripped of control characters and capped", () => {
    const q = blockedQuestion({
      ...{ requestId: "repo2", summary: "s", key: "k", repo: true },
      reason: `node x.js\u001b[2J${"a".repeat(2000)}`,
    });
    expect(q.why).not.toContain("\u001b");
    expect(q.why.length).toBeLessThanOrEqual(600);
  });
});
