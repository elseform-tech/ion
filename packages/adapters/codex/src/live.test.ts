import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, StartOpts } from "@ion/adapter-kit";
import { describe, expect, it } from "vitest";
import { codexGateCall } from "./gate.js";
import { createCodexAdapter } from "./index.js";

// The real Codex. ION_LIVE_CODEX=1 (uses your Codex plan's quota; ION_CODEX_MODEL picks a model).
const enabled = process.env.ION_LIVE_CODEX === "1";

async function run(text: string, o: Partial<StartOpts> = {}): Promise<AdapterEvent[]> {
  const cwd = mkdtempSync(join(tmpdir(), "ion-live-"));
  execFileSync("git", ["init", "-q"], { cwd });
  writeFileSync(join(cwd, "notes.txt"), "kiwi-42\n");
  const s = await createCodexAdapter().start({
    cwd,
    model: process.env.ION_CODEX_MODEL ?? null,
    effort: "low",
    signal: new AbortController().signal,
    decide: async () => "deny",
    ...o,
  });
  await s.send({ text });
  const events: AdapterEvent[] = [];
  for await (const e of s.events()) events.push(e);
  return events;
}
const textOf = (events: AdapterEvent[]) =>
  events
    .filter((e) => e.type === "message.delta")
    .map((e) => (e.data as { text: string }).text)
    .join("");

describe.skipIf(!enabled)("Codex live", { timeout: 180_000 }, () => {
  it("answers a prompt and finishes", async () => {
    const events = await run("Reply with exactly: hi from ion. Do not use any tools.");
    const text = textOf(events);
    console.log("Codex:", events[0]?.data, JSON.stringify(text.slice(0, 80)), events.at(-1)?.data);
    expect(events.at(-1)).toEqual({ type: "run.finished", data: { status: "done" } });
    expect(text.toLowerCase()).toContain("hi");
  });

  /** A gate on localhost that records each call and answers `decision`. */
  async function withGate(decision: "allow" | "deny", f: (url: string, calls: unknown[]) => Promise<void>) {
    const calls: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push(codexGateCall(JSON.parse(body)));
        res.end(JSON.stringify({ decision, reason: "Not now" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await f(`http://127.0.0.1:${(server.address() as AddressInfo).port}/gate/k3y`, calls);
    } finally {
      server.close();
    }
  }

  // Every tool call reaches ion's gate before it runs; a deny stops it.
  it("sends a command to ion's gate, which stops it", () =>
    withGate("deny", async (url, calls) => {
      const events = await run("Run the shell command `cat notes.txt` and tell me what it printed.", {
        gate: { url },
      });
      console.log("Codex gate:", calls, JSON.stringify(textOf(events).slice(0, 120)));
      expect(calls[0]).toMatchObject({ kind: "command" });
      expect(textOf(events)).not.toContain("kiwi-42");
    }));

  // Security review, 2026-11-19: the commands Codex runs must not see the gate's address and key.
  it("keeps the gate's address from the commands it runs", () =>
    withGate("allow", async (url, calls) => {
      const events = await run(
        "Run exactly this shell command: printenv ION_GATE_URL; echo end. Reply with its output verbatim.",
        { gate: { url }, decide: async () => "allow" },
      );
      const out = events
        .filter((e) => e.type === "tool.output")
        .map((e) => (e.data as { text: string }).text);
      console.log("Codex env:", calls, out);
      expect(calls[0]).toMatchObject({ kind: "command" });
      expect(out.join("")).toContain("end");
      expect(JSON.stringify(events)).not.toContain("k3y");
    }));
});
