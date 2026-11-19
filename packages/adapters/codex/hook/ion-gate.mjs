// ion's gate for Codex: a PreToolUse hook ion passes to Codex (with -c) for the runs it starts, never written
// into your Codex folder. Every tool call is sent to ion (ION_GATE_URL) before it runs and runs only if ion
// allows it. Fail closed: no address, no answer or anything but an allow blocks the call.
import { readFileSync } from "node:fs";

const deny = (reason) =>
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );

async function main() {
  const url = process.env.ION_GATE_URL;
  if (!url) return deny("ion's gate isn't set up for this run, so this was blocked");
  let answer;
  try {
    const p = JSON.parse(readFileSync(0, "utf8"));
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_name: p.tool_name, tool_input: p.tool_input, cwd: p.cwd }),
      // Codex gives the hook 300 s; ion answers first, so a slow answer is a deny, not a hook timeout.
      signal: AbortSignal.timeout(290_000),
    });
    answer = await res.json();
  } catch {
    return deny("ion didn't answer, so this was blocked");
  }
  if (answer?.decision !== "allow")
    deny(typeof answer?.reason === "string" ? answer.reason : "Not allowed by ion");
}

await main();
