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
});
