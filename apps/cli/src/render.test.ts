import type { IonEvent } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { createRenderer } from "./render.js";

const ev = (type: string, data: Record<string, unknown>): IonEvent =>
  ({
    v: 1,
    id: "x",
    chatId: "c",
    runId: "r",
    seq: 1,
    ts: "2026-11-17T10:00:00.000Z",
    origin: "adapter",
    type,
    data,
  }) as IonEvent;

describe("render", () => {
  it("shows an edit without line counts as just the path", () => {
    const r = createRenderer();
    expect(
      r(ev("file.changed", { path: "notes.md", change: "modify", added: null, removed: null })).text,
    ).toBe("· Edited notes.md\n");
    expect(r(ev("file.changed", { path: "a.ts", change: "modify", added: 3, removed: 1 })).text).toBe(
      "· Edited a.ts (+3 −1)\n",
    );
  });

  // Regression (security review): agent text must not drive the terminal.
  it("strips control characters and escape sequences from what agents send", () => {
    const r = createRenderer();
    const evil = "ok\u001b[2J\u001b]0;pwned\u0007\u0000done";
    expect(r(ev("message.delta", { text: evil })).text).toBe("ok[2J]0;pwneddone");
    expect(
      r(ev("tool.started", { toolId: "t", name: "Read", kind: "read", summary: "a\u001b[31m.ts" })).text,
    ).toBe("\n· Read a[31m.ts\n");
  });

  it("keeps one-line fields on one line and drops invisible direction marks", () => {
    const r = createRenderer();
    const spoof = "a.ts\nDone · 0.1s\u202e";
    expect(r(ev("file.changed", { path: spoof, change: "modify", added: null, removed: null })).text).toBe(
      "· Edited a.ts Done · 0.1s\n",
    );
  });

  it("says when a run waits on you, and how to answer", () => {
    const r = createRenderer();
    expect(r(ev("need.raised", { needId: "n1a2b3", summary: "Run pnpm test", kind: "command" })).text).toBe(
      "· Waiting on you: Run pnpm test — run: ion needs allow n1a2b3\n",
    );
  });

  it("says when a run retries, and shows the harness line only once", () => {
    const r = createRenderer();
    const started = ev("run.started", { harness: "fake", model: "fake" });
    expect(r(started).text).toBe("Fake · fake\n");
    expect(
      r(ev("run.retrying", { attempt: 1, delayS: 3.2, reason: "Rate limited", effort: null })).text,
    ).toBe("· Retrying in 4s (rate limited)\n");
    expect(r(started).text).toBe("");
    expect(r(ev("run.retrying", { attempt: 1, delayS: 0, reason: "x", effort: "max" })).text).toBe(
      "· Retrying now at max effort (x)\n",
    );
  });
});
