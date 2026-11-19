import { describe, expect, it } from "vitest";
import { type CodexState, createCodexState, mapNotification } from "./map.js";

const started = (item: object) => ({ item, threadId: "t", turnId: "u", startedAtMs: 1 });
const completed = (item: object) => ({ item, threadId: "t", turnId: "u", completedAtMs: 2 });
const map = (s: CodexState, method: string, params: object) => mapNotification(method, params, s);

// Shapes from codex-cli 0.153.2's app-server (seen live, and its generated protocol types).
describe("Codex app-server notifications", () => {
  it("streams text and thinking, and the whole message when it ends", () => {
    const s = createCodexState(["/w"]);
    expect(map(s, "item/agentMessage/delta", { itemId: "m", delta: "Hi" })).toEqual([
      { type: "message.delta", data: { text: "Hi" } },
    ]);
    expect(map(s, "item/reasoning/summaryTextDelta", { itemId: "r", delta: "hmm" })).toEqual([
      { type: "thinking.delta", data: { text: "hmm" } },
    ]);
    expect(map(s, "item/completed", completed({ type: "agentMessage", id: "m", text: "Hi there" }))).toEqual([
      { type: "message.completed", data: { text: "Hi there" } },
    ]);
    expect(map(s, "item/completed", completed({ type: "agentMessage", id: "m2", text: "" }))).toEqual([]);
  });

  it("shows a command as the model wrote it, with its output", () => {
    const s = createCodexState(["/w"]);
    const item = { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'cat notes.txt'", cwd: "/w" };
    expect(map(s, "item/started", started({ ...item, status: "inProgress" }))).toEqual([
      {
        type: "tool.started",
        data: {
          toolId: "c1",
          name: "shell",
          kind: "command",
          summary: "cat notes.txt",
          input: "cat notes.txt",
        },
      },
    ]);
    const done = { ...item, status: "completed", aggregatedOutput: "hello\n", exitCode: 0 };
    expect(map(s, "item/completed", completed(done))).toEqual([
      { type: "tool.output", data: { toolId: "c1", text: "hello\n" } },
      { type: "tool.finished", data: { toolId: "c1", ok: true, summary: null } },
    ]);
  });

  it("reports an edit's files, with lines added and removed", () => {
    const s = createCodexState(["/w"]);
    const changes = [
      {
        path: "/w/notes.md",
        kind: { type: "update", move_path: null },
        diff: "@@ -1 +1,2 @@\n hi\n-a\n+b\n+c\n",
      },
      { path: "/w/new.md", kind: { type: "add" }, diff: "one\ntwo\n" },
      { path: "/w/old.md", kind: { type: "delete" }, diff: "x\n" },
      { path: "/w/a.md", kind: { type: "update", move_path: "/w/b.md" }, diff: "" },
    ];
    const item = { type: "fileChange", id: "f1", changes };
    const [start] = map(s, "item/started", started({ ...item, status: "inProgress" }));
    expect(start).toMatchObject({
      type: "tool.started",
      data: { toolId: "f1", name: "apply_patch", kind: "edit", summary: "notes.md and 3 more" },
    });
    // Review, 2026-11-19: a move is judged by both paths (it removes one file and writes another).
    expect(s.edits.get("f1")).toEqual(["/w/notes.md", "/w/new.md", "/w/old.md", "/w/a.md", "/w/b.md"]);
    expect(map(s, "item/completed", completed({ ...item, status: "completed" }))).toEqual([
      { type: "tool.finished", data: { toolId: "f1", ok: true, summary: null } },
      { type: "file.changed", data: { path: "notes.md", change: "modify", added: 2, removed: 1 } },
      { type: "file.changed", data: { path: "new.md", change: "add", added: 2, removed: null } },
      { type: "file.changed", data: { path: "old.md", change: "delete", added: null, removed: 1 } },
      { type: "file.changed", data: { path: "b.md", change: "modify", added: 0, removed: 0 } },
    ]);
  });

  it("changes nothing when an edit is declined", () => {
    const s = createCodexState(["/w"]);
    const item = {
      type: "fileChange",
      id: "f1",
      changes: [{ path: "/w/a", kind: { type: "add" }, diff: "x" }],
    };
    map(s, "item/started", started({ ...item, status: "inProgress" }));
    expect(map(s, "item/completed", completed({ ...item, status: "declined" }))).toEqual([
      { type: "tool.finished", data: { toolId: "f1", ok: false, summary: null } },
    ]);
  });

  it("shows MCP tool calls and web searches", () => {
    const s = createCodexState(["/w"]);
    const mcp = {
      type: "mcpToolCall",
      id: "m1",
      server: "ion",
      tool: "search_chats",
      arguments: { query: "kiwi" },
    };
    expect(map(s, "item/started", started({ ...mcp, status: "inProgress" }))).toEqual([
      {
        type: "tool.started",
        data: {
          toolId: "m1",
          name: "mcp__ion__search_chats",
          kind: "mcp",
          summary: "ion: search_chats",
          input: '{\n  "query": "kiwi"\n}',
        },
      },
    ]);
    const result = { content: [{ type: "text", text: "found" }] };
    expect(map(s, "item/completed", completed({ ...mcp, status: "completed", result }))).toEqual([
      { type: "tool.output", data: { toolId: "m1", text: "found" } },
      { type: "tool.finished", data: { toolId: "m1", ok: true, summary: null } },
    ]);
    // A finished call can't be approved any more (security review, 2026-11-19).
    expect(s.mcp.has("m1")).toBe(false);
    expect(map(s, "item/started", started({ type: "webSearch", id: "w1", query: "ion" }))).toMatchObject([
      { type: "tool.started", data: { kind: "web", summary: "ion" } },
    ]);
  });

  it("finishes only tools it started", () => {
    const s = createCodexState(["/w"]);
    const item = { type: "commandExecution", id: "c9", command: "ls", status: "completed" };
    expect(map(s, "item/completed", completed(item))).toEqual([]);
  });

  it("adds up the turn's tokens and keeps its last error", () => {
    const s = createCodexState(["/w"]);
    const usage = (input: number, output: number) => ({
      tokenUsage: { total: {}, last: { inputTokens: input, outputTokens: output } },
    });
    map(s, "thread/tokenUsage/updated", usage(100, 10));
    map(s, "thread/tokenUsage/updated", usage(50, 5));
    expect(s.usage).toEqual({ inputTokens: 150, outputTokens: 15 });
    map(s, "error", { error: { message: "retrying" }, willRetry: true });
    expect(s.error).toBeNull();
    map(s, "error", { error: { message: "gone", codexErrorInfo: "other" }, willRetry: false });
    expect(s.error).toEqual({ message: "gone", codexErrorInfo: "other" });
  });

  it("ignores what it doesn't know", () => {
    const s = createCodexState(["/w"]);
    expect(map(s, "thread/started", {})).toEqual([]);
    expect(map(s, "item/started", started({ type: "plan", id: "p" }))).toEqual([]);
  });
});
