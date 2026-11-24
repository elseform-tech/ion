// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Work } from "./steps.js";
import { stepName, WorkBlock } from "./Work.js";

afterEach(cleanup);

const work = (steps: Work["steps"], ended: string | null = "2026-11-18T10:00:05.000Z"): Work => ({
  kind: "work",
  runId: "r1",
  started: "2026-11-18T10:00:00.000Z",
  ...(ended ? { ended } : {}),
  steps,
});
const tool = (name: string, summary: string, more: object = {}) =>
  ({ kind: "tool", toolKind: "mcp", name, summary, ok: true, ...more }) as Work["steps"][number];

// Task review, 2026-11-19: an ion's steps read "mcp__ion__projects projects". A step shows a plain name, without
// its MCP server's prefix (or ACP's "ion__"), ion's own tools in words, and no summary that only repeats the name.
describe("a work step's name", () => {
  it("drops a server's prefix and names ion's own tools in words", () => {
    expect(stepName("mcp__ion__projects")).toBe("Projects");
    expect(stepName("ion__search_chats")).toBe("Search chats");
    expect(stepName("mcp__ion__chat_history")).toBe("Chat history");
    expect(stepName("mcp__ion__open_needs")).toBe("Open questions");
    expect(stepName("mcp__ion__memory_list")).toBe("Memory");
    expect(stepName("mcp__ion__memory_write")).toBe("Remember");
    // Plan 19, 2026-11-22: memory is files, found and read through these (older chats' memory_list stays "Memory").
    expect(stepName("mcp__ion__memory_index")).toBe("Memory");
    expect(stepName("mcp__ion__memory_search")).toBe("Search memory");
    expect(stepName("mcp__ion__memory_read")).toBe("Read memory");
    expect(stepName("ion__memory_forget")).toBe("Forget");
    expect(stepName("ion__decisions")).toBe("Decisions");
    expect(stepName("mcp__ion__set_profile")).toBe("Suggest profile");
    expect(stepName("mcp__ion__start_thread")).toBe("Start chat");
    expect(stepName("mcp__ion__ask")).toBe("Ask");
    expect(stepName("mcp__ion__report_outcome")).toBe("Report outcome");
    expect(stepName("mcp__github__create_issue")).toBe("create_issue");
    expect(stepName("Read")).toBe("Read");
  });

  // Task 7, 2026-11-20: an ion's (and a chat's) web steps read in plain words, whichever agent ran them.
  it("names web steps plainly", () => {
    for (const n of ["WebSearch", "web_search", "websearch"]) expect(stepName(n)).toBe("Search the web");
    for (const n of ["WebFetch", "web_fetch", "webfetch"]) expect(stepName(n)).toBe("Read a page");
  });

  // Security review, 2026-11-19: a routed tool name is checked before it names a step.
  it("shows Tool for a step with no name", () => {
    expect(stepName("")).toBe("Tool");
    expect(stepName("\u202e")).toBe("Tool");
  });

  it("shows plain names, no repeated summary, and no control characters", () => {
    const steps = [
      tool("mcp__ion__projects", "projects"),
      tool("mcp__ion__start_thread", "Start chat"),
      tool("Re\u0007ad", "src/\u001b[31mcart.ts", { input: "in\u0000put", output: "out\u0007put" }),
      {
        kind: "think" as const,
        text: "Look\u0007 first.",
        from: "2026-11-18T10:00:00.000Z",
        to: "2026-11-18T10:00:02.000Z",
      },
    ];
    const { container } = render(<WorkBlock w={work(steps)} />);
    fireEvent.click(screen.getByRole("button", { name: /Worked/ }));
    const rows = [...container.querySelectorAll(".ws .wl")].map((r) => r.textContent);
    expect(rows[0]).toBe("Projects");
    expect(rows[1]).toBe("Start chat");
    expect(rows[2]).toBe("Read src/[31mcart.ts");
    fireEvent.click(screen.getByText("Read"));
    expect(screen.getByText("input")).toBeTruthy();
    expect(screen.getByText("output")).toBeTruthy();
    expect(screen.getByText("Look first.")).toBeTruthy();
    expect(container.textContent).not.toMatch(/[\u0000-\u0008\u001b]/);
  });

  // Security review, 2026-11-19: a step's label comes from the harness's structured call, never from free text.
  it("labels a step by its name, never by its summary", () => {
    const steps = [tool("ion__projects", ""), tool("Use tool", "ion__projects")];
    const { container } = render(<WorkBlock w={work(steps)} />);
    fireEvent.click(screen.getByRole("button", { name: /Worked/ }));
    const rows = [...container.querySelectorAll(".ws .wl")].map((r) => r.textContent);
    expect(rows[0]).toBe("Projects");
    expect(rows[1]).toBe("Use tool ion__projects");
  });

  it("shows a live step by its plain name", () => {
    const { container } = render(<WorkBlock w={work([tool("mcp__ion__open_needs", "open_needs")], null)} />);
    expect(container.querySelector(".wh .now")?.textContent).toBe("Open questions");
  });

  // Task review tour, 2026-11-19: a turn just started read "Projects · 0s"; a time that says nothing isn't shown.
  it("shows no time on live work under a second old", () => {
    const fresh = { ...work([tool("Read", "a.ts")], null), started: new Date().toISOString() };
    const { container } = render(<WorkBlock w={fresh} />);
    expect(container.querySelector(".wh")?.textContent).toBe("Read a.ts");
  });
});
