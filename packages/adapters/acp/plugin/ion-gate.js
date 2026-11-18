// ion's gate for opencode: every tool call is reported to ion before it runs, and runs only if ion allows it.
// Loaded by ion through OPENCODE_CONFIG_CONTENT; it does nothing outside a run ion started (no ION_GATE_URL).
// Fail closed: if ion doesn't answer, the call is blocked.
export const IonGate = async () => ({
  "tool.execute.before": async (input, output) => {
    const url = process.env.ION_GATE_URL;
    if (!url) return;
    let answer;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: input.tool, args: output.args }),
        signal: AbortSignal.timeout(60_000),
      });
      answer = await res.json();
    } catch {
      throw new Error("ion didn't answer, so this was blocked");
    }
    if (answer?.decision !== "allow") throw new Error(answer?.reason ?? "Not allowed by ion");
  },
});
