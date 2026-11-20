import { describe, expect, it } from "vitest";
import { createAcpState, mapUpdate } from "./map.js";

const s = () => createAcpState(["/repo"]);

describe("mapUpdate", () => {
  it("message and thought chunks", () => {
    expect(
      mapUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } }, s()),
    ).toEqual([{ type: "message.delta", data: { text: "Hi" } }]);
    expect(
      mapUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Hmm" } }, s()),
    ).toEqual([{ type: "thinking.delta", data: { text: "Hmm" } }]);
  });

  it("tool calls start and finish, with kinds mapped", () => {
    const st = s();
    expect(
      mapUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "pnpm test", kind: "execute" }, st),
    ).toEqual([
      {
        type: "tool.started",
        data: { toolId: "t1", name: "execute", kind: "command", summary: "pnpm test" },
      },
    ]);
    expect(
      mapUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" }, st),
    ).toEqual([]);
    expect(mapUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" }, st)).toEqual([
      { type: "tool.finished", data: { toolId: "t1", ok: false, summary: null } },
    ]);
  });

  it("diffs become file changes with line counts, relative to the project", () => {
    const st = s();
    mapUpdate({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit", kind: "edit" }, st);
    expect(
      mapUpdate(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t2",
          status: "completed",
          content: [
            { type: "diff", path: "/repo/a.ts", oldText: "a\nb", newText: "a\nb\nc" },
            { type: "diff", path: "/repo/new.md", newText: "x" },
          ],
        },
        st,
      ),
    ).toEqual([
      { type: "tool.finished", data: { toolId: "t2", ok: true, summary: null } },
      { type: "file.changed", data: { path: "a.ts", change: "modify", added: 3, removed: 2 } },
      { type: "file.changed", data: { path: "new.md", change: "add", added: 1, removed: null } },
    ]);
  });

  it("remembers cost from usage updates, and ignores unknown kinds", () => {
    const st = s();
    expect(
      mapUpdate(
        { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.01, currency: "USD" } },
        st,
      ),
    ).toEqual([]);
    expect(st.costUsd).toBeCloseTo(0.01);
    expect(mapUpdate({ sessionUpdate: "brand_new_thing" }, st)).toEqual([]);
  });

  it("reports an edit from its locations when the agent sends no diff", () => {
    const st = s();
    mapUpdate(
      { sessionUpdate: "tool_call", toolCallId: "w", title: "write", kind: "edit", locations: [] },
      st,
    );
    mapUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "w",
        status: "in_progress",
        locations: [{ path: "/repo/notes.md" }],
      },
      st,
    );
    expect(
      mapUpdate(
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "w",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "ok" } }],
        },
        st,
      ),
    ).toEqual([
      { type: "tool.output", data: { toolId: "w", text: "ok" } },
      { type: "tool.finished", data: { toolId: "w", ok: true, summary: null } },
      { type: "file.changed", data: { path: "notes.md", change: "modify", added: null, removed: null } },
    ]);
  });
});

// Plan 07: each tool's input and output, for the chat to show.
describe("tool input and output", () => {
  it("passes the input given at the start, and the output at the end", () => {
    const st = s();
    const [started] = mapUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "ls",
        kind: "execute",
        rawInput: { command: "ls" },
      },
      st,
    );
    expect(started?.data).toMatchObject({ input: '{\n  "command": "ls"\n}' });
    const done = mapUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "a.ts\nb.ts" } }],
      },
      st,
    );
    expect(done[0]).toEqual({ type: "tool.output", data: { toolId: "t1", text: "a.ts\nb.ts" } });
    expect(done[1]).toMatchObject({ type: "tool.finished", data: { toolId: "t1", ok: true } });
  });

  it("passes an input that only arrives later, and output given as rawOutput", () => {
    const st = s();
    mapUpdate({ sessionUpdate: "tool_call", toolCallId: "t2", title: "bash", kind: "execute" }, st);
    mapUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t2",
        status: "in_progress",
        rawInput: { command: "pwd" },
      },
      st,
    );
    const done = mapUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t2",
        status: "completed",
        rawOutput: { output: "/repo" },
      },
      st,
    );
    expect(done).toEqual([
      { type: "tool.output", data: { toolId: "t2", text: "/repo" } },
      {
        type: "tool.finished",
        data: { toolId: "t2", ok: true, summary: null, input: '{\n  "command": "pwd"\n}' },
      },
    ]);
  });
});

// Real run on Grok, 2026-11-19: a grep showed as "other grep" (ACP's kind, then the title). A tool of no known kind
// is named by its title (Grok's own in plain words), with what it looked for.
describe("a tool of no known kind", () => {
  it("is named by its title, with its pattern or query", () => {
    const st = s();
    const grep = { sessionUpdate: "tool_call", toolCallId: "g", title: "grep", kind: "other" };
    expect(
      mapUpdate({ ...grep, rawInput: { pattern: "tip", glob: "**/split.js" } }, st)[0]?.data,
    ).toMatchObject({
      name: "Grep",
      kind: "other",
      summary: "tip",
    });
    const find = { sessionUpdate: "tool_call", toolCallId: "f", title: "search_tool", kind: "other" };
    expect(mapUpdate({ ...find, rawInput: { query: "ion decisions ask" } }, st)[0]?.data).toMatchObject({
      name: "Find tool",
      summary: "ion decisions ask",
    });
    // Same run: Grok's read_file and list_dir came with no detail (they name target_file, target_directory).
    const read = { sessionUpdate: "tool_call", toolCallId: "r", title: "read_file", kind: "other" };
    expect(mapUpdate({ ...read, rawInput: { target_file: "/repo/split.js" } }, st)[0]?.data).toMatchObject({
      name: "Read",
      summary: "split.js",
    });
    const list = { sessionUpdate: "tool_call", toolCallId: "l", title: "list_dir", kind: "other" };
    expect(mapUpdate({ ...list, rawInput: { target_directory: "/repo" } }, st)[0]?.data).toMatchObject({
      name: "List",
      summary: "/repo",
    });
  });
});
