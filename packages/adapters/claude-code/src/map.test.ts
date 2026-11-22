import { describe, expect, it } from "vitest";
import { createMapState, mapSdkMessage } from "./map.js";

/** The events without each tool's input and output (covered by their own test below). */
const withoutIo = (evs: { type: string; data: unknown }[]) =>
  evs
    .filter((e) => e.type !== "tool.output")
    .map((e) => {
      const data = { ...(e.data as Record<string, unknown>) };
      delete data.input;
      return { ...e, data };
    });

const state = () => createMapState({ cwd: "/repo", effort: "high", authMethod: "Claude subscription" });
const types = (evs: { type: string }[]) => evs.map((e) => e.type);

describe("mapSdkMessage", () => {
  it("init → run.started with model, effort and sign-in method", () => {
    const evs = mapSdkMessage(
      { type: "system", subtype: "init", model: "claude-haiku-5-5", session_id: "s1" } as never,
      state(),
    );
    expect(evs).toEqual([
      {
        type: "run.started",
        data: {
          harness: "claude-code",
          model: "claude-haiku-5-5",
          effort: "high",
          authMethod: "Claude subscription",
          sessionId: "s1",
        },
      },
    ]);
  });

  it("stream text and thinking deltas", () => {
    const s = state();
    const delta = (d: object) =>
      mapSdkMessage(
        { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: d } } as never,
        s,
      );
    expect(delta({ type: "text_delta", text: "Hi" })).toEqual([
      { type: "message.delta", data: { text: "Hi" } },
    ]);
    expect(delta({ type: "thinking_delta", thinking: "Hmm" })).toEqual([
      { type: "thinking.delta", data: { text: "Hmm" } },
    ]);
    expect(delta({ type: "input_json_delta", partial_json: "{" })).toEqual([]);
  });

  it("assistant text and tool_use", () => {
    const evs = mapSdkMessage(
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Reading it." },
            { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/repo/src/a.ts" } },
            {
              type: "tool_use",
              id: "tu2",
              name: "Bash",
              input: { command: "pnpm test --run some/really/long/path" },
            },
          ],
        },
      } as never,
      state(),
    );
    expect(withoutIo(evs)).toEqual([
      { type: "message.completed", data: { text: "Reading it." } },
      { type: "tool.started", data: { toolId: "tu1", name: "Read", kind: "read", summary: "src/a.ts" } },
      {
        type: "tool.started",
        data: {
          toolId: "tu2",
          name: "Bash",
          kind: "command",
          summary: "pnpm test --run some/really/long/path",
        },
      },
    ]);
  });

  it("tool results finish tools, and successful edits report file changes", () => {
    const s = state();
    mapSdkMessage(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "e1",
              name: "Edit",
              input: { file_path: "/repo/a.ts", old_string: "a\nb", new_string: "a\nb\nc\nd" },
            },
            {
              type: "tool_use",
              id: "w1",
              name: "Write",
              input: { file_path: "/repo/notes.md", content: "one\ntwo" },
            },
            { type: "tool_use", id: "w2", name: "Write", input: { file_path: "/repo/x.md", content: "x" } },
          ],
        },
      } as never,
      s,
    );
    const evs = mapSdkMessage(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "e1", is_error: false, content: "ok" },
            { type: "tool_result", tool_use_id: "w1", content: "ok" },
            { type: "tool_result", tool_use_id: "w2", is_error: true, content: "denied" },
          ],
        },
      } as never,
      s,
    );
    expect(withoutIo(evs)).toEqual([
      { type: "tool.finished", data: { toolId: "e1", ok: true, summary: null } },
      { type: "file.changed", data: { path: "a.ts", change: "modify", added: 4, removed: 2 } },
      { type: "tool.finished", data: { toolId: "w1", ok: true, summary: null } },
      { type: "file.changed", data: { path: "notes.md", change: "add", added: 2, removed: null } },
      { type: "tool.finished", data: { toolId: "w2", ok: false, summary: null } },
    ]);
  });

  const result = (subtype: string, extra: object = {}) =>
    ({
      type: "result",
      subtype,
      total_cost_usd: 0.0031,
      usage: { input_tokens: 120, output_tokens: 40 },
      modelUsage: { "claude-haiku-5-5": {} },
      errors: ["boom"],
      ...extra,
    }) as never;

  const errorOf = (evs: { type: string; data?: unknown }[]) => evs.find((e) => e.type === "error")?.data;
  const rateLimit = (resetsInS: number) =>
    ({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + resetsInS },
    }) as never;

  it("a short rate limit is retryable, waiting until it resets", () => {
    const s = state();
    expect(mapSdkMessage(rateLimit(30), s)).toEqual([]);
    const err = errorOf(mapSdkMessage(result("error_during_execution"), s)) as { retryAfterS: number };
    expect(err).toMatchObject({ code: "rate_limit", retryable: true });
    expect(err.retryAfterS).toBeGreaterThan(25);
    expect(err.retryAfterS).toBeLessThanOrEqual(30);
  });

  it("a usage limit that resets in hours isn't retried", () => {
    const s = state();
    mapSdkMessage(rateLimit(3 * 3600), s);
    expect(errorOf(mapSdkMessage(result("error_during_execution"), s))).toMatchObject({
      code: "usage_limit",
      retryable: false,
    });
  });

  // The user, 2026-11-21: Claude's limit carries its reset (rate_limit_info.resetsAt), so ion marks it limited until then.
  it("a limit error marks the agent limited until its reset", () => {
    const s = state();
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
    mapSdkMessage(
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt } } as never,
      s,
    );
    expect(errorOf(mapSdkMessage(result("error_during_execution"), s))).toMatchObject({
      code: "usage_limit",
      limit: { resetsAt: new Date(resetsAt * 1000).toISOString() },
    });
  });

  // The user, 2026-11-21: a 5-hour or weekly limit that names no reset is still the limit (30 min, then one retry).
  it("no reset → limited for 30 min, then one retry", () => {
    const s = state();
    const info = { status: "rejected", rateLimitType: "five_hour" };
    mapSdkMessage({ type: "rate_limit_event", rate_limit_info: info } as never, s);
    expect(errorOf(mapSdkMessage(result("error_during_execution"), s))).toMatchObject({
      code: "usage_limit",
      retryable: false,
      limit: {},
    });
  });

  // Probed on Claude Code 2.1.326 (docs/research/usage-signals.md): each request's rate_limit_info has its windows
  // (unifiedWindows: utilization 0–1, resetsAt in unix seconds), reported with the run's usage.
  it("a window snapshot is stored and shown", () => {
    const s = state();
    const unifiedWindows = {
      five_hour: { utilization: 0.03, resetsAt: 1795393200, status: "allowed" },
      seven_day: { utilization: 0.64, resetsAt: 1795834800, status: "allowed" },
    };
    const info = { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.64, unifiedWindows };
    mapSdkMessage({ type: "rate_limit_event", rate_limit_info: info } as never, s);
    const usage = mapSdkMessage(result("success"), s)[0]?.data as { windows: unknown };
    expect(usage.windows).toEqual([
      { name: "5 h", usedPercent: 3, resetsAt: new Date(1795393200 * 1000).toISOString() },
      { name: "week", usedPercent: 64, resetsAt: new Date(1795834800 * 1000).toISOString() },
    ]);
  });

  it("overloaded and server errors are retryable; account errors aren't", () => {
    const after = (error: string) => {
      const s = state();
      mapSdkMessage({ type: "assistant", error, message: { content: [] } } as never, s);
      return errorOf(mapSdkMessage(result("error_during_execution"), s));
    };
    expect(after("overloaded")).toMatchObject({ code: "overloaded", retryable: true });
    expect(after("server_error")).toMatchObject({ code: "server_error", retryable: true });
    expect(after("billing_error")).toMatchObject({ code: "billing_error", retryable: false });
  });

  it("success → usage then done", () => {
    expect(mapSdkMessage(result("success"), state())).toEqual([
      {
        type: "usage.reported",
        data: { model: "claude-haiku-5-5", inputTokens: 120, outputTokens: 40, costUsd: 0.0031 },
      },
      { type: "run.finished", data: { status: "done" } },
    ]);
  });

  it("an interrupted run ends interrupted, a budget stop ends capped, other errors fail", () => {
    const s = state();
    s.interrupted = true;
    expect(types(mapSdkMessage(result("error_during_execution"), s))).toEqual([
      "usage.reported",
      "run.finished",
    ]);
    expect(mapSdkMessage(result("error_during_execution"), s).at(-1)).toEqual({
      type: "run.finished",
      data: { status: "interrupted" },
    });
    expect(mapSdkMessage(result("error_max_budget_usd"), state()).at(-1)).toEqual({
      type: "run.finished",
      data: { status: "capped" },
    });
    expect(mapSdkMessage(result("error_max_turns"), state()).slice(-2)).toEqual([
      { type: "error", data: { code: "error_max_turns", retryable: false, message: "boom" } },
      { type: "run.finished", data: { status: "failed" } },
    ]);
  });

  it("ignores message types it doesn't know", () => {
    expect(mapSdkMessage({ type: "rate_limit_event" } as never, state())).toEqual([]);
  });
});

// Plan 07: each tool's input and output, for the chat to show.
describe("tool input and output", () => {
  it("passes a tool's input when it starts and its result when it ends", () => {
    const st = createMapState({ cwd: "/repo", effort: null, authMethod: "x" });
    const [started] = mapSdkMessage(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
      },
      st,
    );
    expect(started?.data).toMatchObject({ input: '{\n  "command": "ls"\n}' });
    const out = mapSdkMessage(
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.ts" }] }],
        },
      },
      st,
    );
    expect(out[0]).toEqual({ type: "tool.output", data: { toolId: "t1", text: "a.ts" } });
    expect(out[1]).toMatchObject({ type: "tool.finished", data: { toolId: "t1", ok: true } });
  });
});
