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
      { type: "tool.finished", data: { toolId: "w", ok: true, summary: null } },
      { type: "file.changed", data: { path: "notes.md", change: "modify", added: null, removed: null } },
    ]);
  });
});
