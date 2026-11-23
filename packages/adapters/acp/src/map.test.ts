import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAcpState, mapUpdate } from "./map.js";

// The files under /repo are there already (made-up paths: nothing is read).
const s = () => createAcpState(["/repo"], () => true);

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
        data: { toolId: "t2", ok: true, summary: "pwd", input: '{\n  "command": "pwd"\n}' },
      },
    ]);
  });
});

// Tour, 2026-11-21: opencode's bash steps showed only "bash", not their command (other agents' steps show it).
// opencode sends the command after the step starts; the step's summary becomes the command when it finishes.
describe("a command step", () => {
  it("is summarized by its command, also when the command arrives late", () => {
    const st = s();
    const started = mapUpdate(
      { sessionUpdate: "tool_call", toolCallId: "b1", title: "bash", kind: "execute" },
      st,
    );
    expect(started[0]?.data).toMatchObject({ kind: "command", summary: "bash" });
    mapUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "b1",
        status: "in_progress",
        rawInput: { command: "pnpm test", description: "Runs the tests" },
      },
      st,
    );
    const done = mapUpdate({ sessionUpdate: "tool_call_update", toolCallId: "b1", status: "completed" }, st);
    expect(done.at(-1)?.data).toMatchObject({ toolId: "b1", summary: "pnpm test" });
  });

  it("is summarized by its command when it comes with the start", () => {
    const st = s();
    const started = mapUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "b2",
        title: "bash",
        kind: "execute",
        rawInput: { command: "ls -la" },
      },
      st,
    );
    expect(started[0]?.data).toMatchObject({ summary: "ls -la" });
    const done = mapUpdate({ sessionUpdate: "tool_call_update", toolCallId: "b2", status: "completed" }, st);
    expect(done.at(-1)?.data).toMatchObject({ summary: null });
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
    ).toMatchObject({ name: "Grep", kind: "other", summary: "tip" });
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

  // Task 7 live check, 2026-11-21: Grok's web search came as a "search" step titled "Web search:" (its input
  // `{variant: "WebSearch", backend: true}`), so an ion's work line said "search" like a file search.
  it("names Grok's web search as a web search", () => {
    const [ev] = mapUpdate(
      {
        ...{ sessionUpdate: "tool_call", toolCallId: "w1", title: "Web search:", kind: "search" },
        rawInput: { variant: "WebSearch", backend: true },
      },
      s(),
    );
    expect(ev?.data).toMatchObject({ name: "web_search", kind: "web", summary: "" });
  });

  // Task review, 2026-11-21: any tool_call whose input said {variant: "WebSearch"} was named a web search.
  it("names only Grok's search step from its variant", () => {
    const [ev] = mapUpdate(
      {
        ...{ sessionUpdate: "tool_call", toolCallId: "w2", title: "x", kind: "execute" },
        rawInput: { variant: "WebSearch", command: "ls" },
      },
      s(),
    );
    expect(ev?.data).toMatchObject({ name: "execute", kind: "command" });
  });

  // Task review, 2026-11-21 (seen live on opencode): its web tools came as "websearch" (kind other) and "fetch",
  // so they didn't read as web steps and its search didn't count as one.
  it("names opencode's web steps by their title", () => {
    const step = (title: string, kind: string) =>
      mapUpdate({ sessionUpdate: "tool_call", toolCallId: title, title, kind, rawInput: {} }, s())[0]?.data;
    expect(step("websearch", "other")).toMatchObject({ name: "websearch", kind: "web" });
    expect(step("webfetch", "fetch")).toMatchObject({ name: "webfetch", kind: "web" });
    // Security review, 2026-11-21: a title alone never makes a step a web step; its kind must agree.
    expect(step("webfetch", "execute")).toMatchObject({ name: "execute", kind: "command" });
    expect(step("websearch", "edit")).toMatchObject({ name: "edit", kind: "edit" });
    expect(step("webfetch", "other")).toMatchObject({ kind: "other" });
  });

  // Security review, 2026-11-21: opencode's websearch comes as kind "other" (seen live), the catch-all; a step titled
  // "websearch" of that kind is a web search only when its input is a search's.
  it("a websearch step of kind other with a search's input only", () => {
    const step = (rawInput: object) =>
      mapUpdate(
        { sessionUpdate: "tool_call", toolCallId: "w", title: "websearch", kind: "other", rawInput },
        s(),
      )[0]?.data;
    expect(step({ query: "node", numResults: 5 })).toMatchObject({ name: "websearch", kind: "web" });
    expect(step({ command: "curl https://evil.example/" })).toMatchObject({ kind: "other" });
    expect(step({ query: "x", tool_name: "github__search" })).toMatchObject({ kind: "other" });
  });

  // Security review, 2026-11-19: a step's label comes from the harness's structured call, never from free text.
  it("names a use_tool call by its structured tool_name", () => {
    const [ev] = mapUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "u1",
        title: "use_tool",
        rawInput: { tool_name: "ion__projects" },
      },
      s(),
    );
    expect(ev?.data).toMatchObject({ name: "ion__projects", summary: "" });
  });

  // Security review, 2026-11-19: a routed tool name is checked before it labels a step.
  it("labels a use_tool step by its routed name only when that name is plain", () => {
    const call = (rawInput: object) =>
      mapUpdate({ sessionUpdate: "tool_call", toolCallId: "u2", title: "use_tool", rawInput }, s())[0]?.data;
    expect(call({ tool_name: "" })).toMatchObject({ name: "Use tool" });
    expect(call({ tool_name: "a b\u202e" })).toMatchObject({ name: "Use tool" });
    expect(call({ tool_name: "ion__search_chats", query: "login" })).toMatchObject({
      name: "ion__search_chats",
      summary: "login",
    });
  });

  // The controller's end-to-end check, 2026-11-23: opencode's new hello.txt showed as a modified file. A file that
  // wasn't there when the step began is added.
  it("says a file the step made is added, one already there is modified", () => {
    const root = mkdtempSync(join(tmpdir(), "ion-acp-map-"));
    writeFileSync(join(root, "old.md"), "old\n");
    const st = createAcpState([root]);
    const step = (id: string, file: string) => {
      mapUpdate({ sessionUpdate: "tool_call", toolCallId: id, title: "write", kind: "edit" }, st);
      const at = [{ path: join(root, file) }];
      mapUpdate(
        { sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", locations: at },
        st,
      );
    };
    step("a", "new.md");
    step("b", "old.md");
    writeFileSync(join(root, "new.md"), "new\n");
    writeFileSync(join(root, "old.md"), "changed\n");
    const done = (id: string) =>
      mapUpdate({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" }, st).find(
        (e) => e.type === "file.changed",
      )?.data;
    expect(done("a")).toEqual({ path: "new.md", change: "add", added: null, removed: null });
    expect(done("b")).toEqual({ path: "old.md", change: "modify", added: null, removed: null });
  });

  // Live (Grok), 2026-11-23: Grok's diff for a file it made has oldText "" and showed as modified (+3 −0). Empty old
  // text for a file that wasn't there when the step began is an added file.
  it("says a diff with empty old text for a file that wasn't there is added", () => {
    const root = mkdtempSync(join(tmpdir(), "ion-acp-diff-"));
    const st = createAcpState([root]);
    const path = join(root, "hello.txt");
    const at = [{ path }];
    mapUpdate(
      { sessionUpdate: "tool_call", toolCallId: "g", title: "edit", kind: "edit", locations: at },
      st,
    );
    writeFileSync(path, "hi\n");
    const diff = { type: "diff", path, oldText: "", newText: "hi" };
    const done = mapUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "g", status: "completed", content: [diff] },
      st,
    );
    expect(done.find((e) => e.type === "file.changed")?.data).toEqual({
      path: "hello.txt",
      change: "add",
      added: 1,
      removed: null,
    });
  });
});
