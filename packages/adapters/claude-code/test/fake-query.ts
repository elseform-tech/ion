/** A stand-in for the SDK's query(): scripted, real-shaped messages; honors canUseTool and interrupt(). */
type Opts = Record<string, unknown> & {
  canUseTool?: (
    name: string,
    input: Record<string, unknown>,
    o: { signal: AbortSignal; toolUseID: string; requestId: string },
  ) => Promise<{ behavior: string }>;
};
type UserMsg = { message: { content: string } };

export type FakeQueryCall = { options: Opts; permissionResults?: unknown[] };

export function fakeQuery(calls: FakeQueryCall[] = []) {
  return ({ prompt, options }: { prompt: AsyncIterable<UserMsg>; options: Opts }) => {
    const call: FakeQueryCall = { options, permissionResults: [] };
    calls.push(call);
    let interrupted = false;
    let wedged = false;
    let wake: (() => void) | null = null;
    async function* run() {
      yield { type: "system", subtype: "init", model: "claude-haiku-5-5", session_id: "native-1" };
      for await (const m of prompt) {
        const text = m.message.content;
        if (text.startsWith("approve")) {
          const input = { file_path: `${options.cwd}/notes.md`, content: "hi" };
          yield {
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "tu1", name: "Write", input }] },
          };
          const r = await options.canUseTool!("Write", input, {
            signal: new AbortController().signal,
            toolUseID: "tu1",
            requestId: "rq1",
            suggestions: [
              {
                type: "addRules",
                rules: [{ toolName: "Write" }],
                behavior: "allow",
                destination: "localSettings",
              },
            ],
          } as never);
          call.permissionResults!.push(r);
          const denied = r.behavior !== "allow";
          yield {
            type: "user",
            message: {
              content: [{ type: "tool_result", tool_use_id: "tu1", is_error: denied, content: "x" }],
            },
          };
        } else if (text.startsWith("slow")) {
          yield {
            type: "assistant",
            message: {
              content: [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "sleep 30" } }],
            },
          };
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 30_000);
          });
          yield {
            type: "user",
            message: {
              content: [{ type: "tool_result", tool_use_id: "tu2", is_error: interrupted, content: "" }],
            },
          };
          yield {
            type: "result",
            subtype: interrupted ? "error_during_execution" : "success",
            usage: {},
            errors: [],
          };
          return;
        } else if (text.startsWith("wedged")) {
          // Never answers interrupt; only the abort controller can stop it.
          wedged = true;
          const signal = (options.abortController as AbortController).signal;
          await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
          throw new Error("aborted");
        } else if (text.startsWith("crash")) {
          throw new Error("claude exited with code 1");
        }
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
        };
        yield { type: "assistant", message: { content: [{ type: "text", text: "Hi" }] } };
        yield {
          type: "result",
          subtype: "success",
          total_cost_usd: 0.001,
          usage: { input_tokens: 5, output_tokens: 2 },
        };
        return;
      }
    }
    const it = run();
    return Object.assign(it, {
      interrupt: () => {
        if (wedged) return new Promise<void>(() => {});
        interrupted = true;
        wake?.();
        return Promise.resolve();
      },
    });
  };
}
