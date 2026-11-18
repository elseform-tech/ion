// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { empty, type Item } from "./timeline.js";

const renders = vi.fn();
vi.mock("./Message.js", () => ({
  Markdown: ({ text }: { text: string }) => {
    renders(text);
    return <p>{text}</p>;
  },
}));

const { ChatView } = await import("./ChatView.js");

afterEach(cleanup);

// Final review I2: a new event mustn't re-render (and re-parse) every message already shown.
describe("ChatView", () => {
  it("renders an unchanged message once, however many events follow", () => {
    const a: Item = { kind: "agent", text: "First", done: true };
    const { rerender } = render(<ChatView timeline={{ ...empty(), items: [a] }} />);
    for (let i = 0; i < 5; i++)
      rerender(<ChatView timeline={{ ...empty(), items: [a, { kind: "you", text: `next ${i}` }] }} />);
    expect(renders.mock.calls.filter(([t]) => t === "First")).toHaveLength(1);
  });

  it("lets you open a tool to see its input and output", () => {
    const work: Item = {
      kind: "work",
      runId: "r1",
      tools: [{ name: "Bash", summary: "ls", ok: true, input: '{"command":"ls"}', output: "a.ts" }],
    };
    const { container, getByText } = render(<ChatView timeline={{ ...empty(), items: [work] }} />);
    fireEvent.click(getByText("Used 1 tool"));
    const tool = container.querySelector("details.tool")!;
    expect(tool.querySelector("summary")?.textContent).toBe("Bash ls");
    expect([...tool.querySelectorAll(".tool-io-label")].map((x) => x.textContent)).toEqual([
      "Input",
      "Output",
    ]);
    expect([...tool.querySelectorAll("pre")].map((x) => x.textContent)).toEqual(['{"command":"ls"}', "a.ts"]);
  });
});
