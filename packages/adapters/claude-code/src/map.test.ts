import { describe, expect, it } from "vitest";
import { createMapState, mapSdkMessage } from "./map.js";

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
    expect(evs).toEqual([
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
    expect(evs).toEqual([
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
