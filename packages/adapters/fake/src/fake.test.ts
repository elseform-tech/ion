import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeAdapterContract } from "@ion/adapter-kit/contract";
import { describe, expect, it } from "vitest";
import { createFakeAdapter } from "./index.js";

const cwd = mkdtempSync(join(tmpdir(), "ion-fake-"));
describeAdapterContract("fake", () => createFakeAdapter({ delayMs: 0 }), {
  hello: "hello",
  approve: "approve",
  slow: "slow",
  cwd,
});

async function turn(text: string, decision: "allow" | "deny" = "allow") {
  const session = await createFakeAdapter({ delayMs: 0 }).start({
    cwd,
    model: null,
    effort: null,
    signal: new AbortController().signal,
    decide: async () => decision,
  });
  await session.send({ text });
  const types: string[] = [];
  for await (const e of session.events())
    types.push(e.type === "run.finished" ? `run.finished:${(e.data as { status: string }).status}` : e.type);
  return types;
}

describe("fake adapter scenarios", () => {
  it("edit reads then changes a file", async () => {
    expect(await turn("edit")).toContain("file.changed");
  });
  it("approve + deny reports the tool failed and changes nothing", async () => {
    const t = await turn("approve", "deny");
    expect(t).toContain("approval.requested");
    expect(t).not.toContain("file.changed");
    expect(t.at(-1)).toBe("run.finished:done");
  });
  it("fail emits an error then failed", async () => {
    const t = await turn("fail");
    expect(t.slice(-2)).toEqual(["error", "run.finished:failed"]);
  });
  it("unknown prompts behave like hello", async () => {
    expect(await turn("what is up")).toContain("message.completed");
  });
});
