// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const view = (items: Item[]) => render(<ChatView timeline={{ ...empty(), items }} />);
const work = (o: Partial<Extract<Item, { kind: "work" }>> = {}): Item => ({
  kind: "work",
  runId: "r1",
  started: "2026-11-18T10:00:00.000Z",
  ended: "2026-11-18T10:02:04.000Z",
  steps: [
    {
      kind: "tool",
      toolKind: "read",
      name: "Read",
      summary: "a.ts",
      ok: true,
      input: '{"file_path":"a.ts"}',
      output: "x",
    },
    { kind: "tool", toolKind: "command", name: "Bash", summary: "pnpm test", ok: false },
  ],
  ...o,
});

describe("ChatView", () => {
  it("renders an unchanged message once, however many events follow", () => {
    const a: Item = { kind: "agent", text: "First", done: true };
    const { rerender } = render(<ChatView timeline={{ ...empty(), items: [a] }} />);
    for (let i = 0; i < 5; i++)
      rerender(<ChatView timeline={{ ...empty(), items: [a, { kind: "you", text: `next ${i}` }] }} />);
    expect(renders.mock.calls.filter(([t]) => t === "First")).toHaveLength(1);
  });

  // Review Focus 1: a long run stays cheap: a new step re-renders its work block, not the messages around it.
  it("renders 300 steps, and a new step leaves unchanged messages alone", () => {
    const steps = Array.from({ length: 300 }, (_, i) => ({
      kind: "tool" as const,
      toolKind: "read",
      name: "Read",
      summary: `f${i}.ts`,
      ok: true,
    }));
    const a: Item = { kind: "agent", text: "Before", done: true };
    const w = work({ steps });
    const { container, rerender } = render(<ChatView timeline={{ ...empty(), items: [a, w] }} />);
    fireEvent.click(container.querySelector(".wh")!);
    expect(container.querySelectorAll(".ws")).toHaveLength(300);
    const more = work({ steps: [...steps, { ...steps[0]!, summary: "g.ts" }] });
    rerender(<ChatView timeline={{ ...empty(), items: [a, more] }} />);
    expect(renders.mock.calls.filter(([t]) => t === "Before")).toHaveLength(1);
  });

  // Plan 08: the lab's conversation: .u for you, .a for the agent.
  it("draws your messages and the agent's as the lab", () => {
    const { container } = view([
      { kind: "you", text: "Fix it" },
      { kind: "agent", text: "Done", done: true },
    ]);
    expect(container.querySelector(".msgs .col .u")?.textContent).toBe("Fix it");
    expect(container.querySelector(".msgs .col .a")?.textContent).toBe("Done");
  });

  it("shows a run's work as the lab's umbrella: 'Worked for', one step per tool, failed ones marked", () => {
    const { container } = view([work()]);
    expect(container.querySelector(".work .wh")?.textContent).toBe("Worked for 2m 04s");
    fireEvent.click(container.querySelector(".wh")!);
    const steps = [...container.querySelectorAll(".ws")];
    expect(steps.map((s) => s.querySelector(".wl")?.textContent)).toEqual(["Read a.ts", "Bash pnpm test"]);
    expect(steps[1]!.classList.contains("w-err")).toBe(true);
  });

  // Final review I2: a closed block draws no steps, so a live run's tick doesn't re-render hundreds of hidden rows.
  it("draws no steps while the block is closed", () => {
    const { container } = view([work({ ended: undefined })]);
    expect(container.querySelectorAll(".ws")).toHaveLength(0);
  });

  it("opens a step to show what went in and came out", () => {
    const { container } = view([work()]);
    fireEvent.click(container.querySelector(".wh")!);
    fireEvent.click(container.querySelector(".ws")!);
    expect([...container.querySelectorAll(".ws .wg pre")].map((p) => p.textContent)).toEqual([
      '{"file_path":"a.ts"}',
      "x",
    ]);
  });

  it("says 'Thought for' when the run only thought, and shows its thinking", () => {
    const { container } = view([
      work({
        steps: [
          {
            kind: "think",
            text: "Look at totals",
            from: "2026-11-18T10:00:01.000Z",
            to: "2026-11-18T10:00:05.000Z",
          },
        ],
        ended: "2026-11-18T10:00:05.000Z",
      }),
    ]);
    expect(container.querySelector(".wh")?.textContent).toBe("Thought for 5s");
    fireEvent.click(container.querySelector(".wh")!);
    expect(container.querySelector(".ws.think .wl")?.textContent).toBe("Thought for 4sLook at totals");
  });

  it("shows a live run's current step with a spinner", () => {
    const { container } = view([work({ ended: undefined })]);
    expect(container.querySelector(".wh .spin")).not.toBeNull();
    expect(container.querySelector(".wh .now")?.textContent).toBe("Bash pnpm test");
  });

  // Review Focus 2: an agent's text inside lab components is text.
  it("shows HTML in a tool's name or argument as text", () => {
    const { container } = view([
      work({
        steps: [
          { kind: "tool", toolKind: "command", name: "<b>x</b>", summary: '<img src=x onerror="alert(1)">' },
        ],
      }),
    ]);
    fireEvent.click(container.querySelector(".wh")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".ws .wl")?.textContent).toBe('<b>x</b> <img src=x onerror="alert(1)">');
  });

  // Plan 08, a quiet chat.
  it("keeps errors, denials and stops to one quiet line each, and adds no hint text", () => {
    const { container } = view([
      { kind: "error", text: "Rate limited" },
      { kind: "ion", tone: "deny", text: "Denied by ion: cat ~/.ssh/id_rsa — Touches your secrets" },
      { kind: "end", status: "done", seconds: 3 },
      { kind: "end", status: "interrupted", seconds: 3 },
    ]);
    const lines = [...container.querySelectorAll(".quiet")].map((x) => x.textContent);
    expect(lines).toEqual([
      "Rate limited",
      "Denied by ion: cat ~/.ssh/id_rsa — Touches your secrets",
      "Stopped",
    ]);
  });

  it("counts a retry down, and drops it once it starts", () => {
    vi.useFakeTimers({ now: new Date("2026-11-18T10:00:00.000Z") });
    const { container, rerender } = view([{ kind: "retry", until: "2026-11-18T10:00:03.000Z", done: false }]);
    expect(container.querySelector(".msgs")?.textContent).toBe("Retrying in 3s");
    act(() => vi.advanceTimersByTime(1000));
    expect(container.querySelector(".msgs")?.textContent).toBe("Retrying in 2s");
    rerender(
      <ChatView
        timeline={{ ...empty(), items: [{ kind: "retry", until: "2026-11-18T10:00:03.000Z", done: true }] }}
      />,
    );
    expect(container.querySelector(".msgs")?.textContent).toBe("");
  });
});
