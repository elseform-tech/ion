import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, Session } from "@ion/adapter-kit";
import { describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "./index.js";

// Real Claude Code, real quota: only with ION_LIVE_CLAUDE=1, and only when this adapter changed.
const live = process.env.ION_LIVE_CLAUDE === "1";

const repo = () => {
  const cwd = mkdtempSync(join(tmpdir(), "ion-live-"));
  execFileSync("git", ["init", "-q"], { cwd });
  return cwd;
};

async function collect(session: Session, onEvent?: (e: AdapterEvent) => void) {
  const events: AdapterEvent[] = [];
  for await (const e of session.events()) {
    events.push(e);
    onEvent?.(e);
  }
  return events;
}

describe.skipIf(!live)("Claude Code live", { timeout: 120_000 }, () => {
  const start = (decide: "allow" | "deny") =>
    createClaudeCodeAdapter().start({
      cwd: repo(),
      model: "haiku",
      effort: "low",
      signal: new AbortController().signal,
      decide: async () => decide,
    });

  it("answers and finishes", async () => {
    const s = await start("allow");
    await s.send({ text: "Say hi in five words. No tools." });
    expect((await collect(s)).at(-1)).toEqual({ type: "run.finished", data: { status: "done" } });
  });

  it("stops a running command when interrupted", async () => {
    const s = await start("allow");
    await s.send({ text: "Run exactly this bash command and nothing else: sleep 30" });
    const started = Date.now();
    const events = await collect(s, (e) => {
      if (e.type === "tool.started") void s.interrupt();
    });
    expect(events.at(-1)).toEqual({ type: "run.finished", data: { status: "interrupted" } });
    expect(Date.now() - started).toBeLessThan(25_000);
  });
});
