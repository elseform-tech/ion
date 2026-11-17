import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent } from "@ion/adapter-kit";
import { describe, expect, it } from "vitest";
import { type AcpHarness, createAcpAdapter, GROK_BUILD, OPENCODE } from "./index.js";

// Real agents. ION_LIVE=1: opencode on a free model. ION_LIVE_GROK=1: Grok Build (uses your Grok quota).
const cases: [AcpHarness, boolean][] = [
  [OPENCODE, process.env.ION_LIVE === "1"],
  [GROK_BUILD, process.env.ION_LIVE_GROK === "1"],
];

for (const [harness, enabled] of cases) {
  describe.skipIf(!enabled)(`${harness.label} live`, { timeout: 180_000 }, () => {
    it("answers a prompt and finishes", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "ion-live-"));
      execFileSync("git", ["init", "-q"], { cwd });
      const s = await createAcpAdapter(harness).start({
        cwd,
        model: null,
        effort: "low",
        signal: new AbortController().signal,
        decide: async () => "deny",
      });
      await s.send({ text: "Reply with exactly: hi from ion. Do not use any tools." });
      const events: AdapterEvent[] = [];
      for await (const e of s.events()) events.push(e);
      const text = events
        .filter((e) => e.type === "message.delta")
        .map((e) => (e.data as { text: string }).text)
        .join("");
      console.log(
        `${harness.label}:`,
        events[0]?.data,
        JSON.stringify(text.slice(0, 80)),
        events.at(-1)?.data,
      );
      expect(events.at(-1)).toEqual({ type: "run.finished", data: { status: "done" } });
      expect(text.toLowerCase()).toContain("hi");
    });
  });
}
