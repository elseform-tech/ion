import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeAdapterContract } from "@ion/adapter-kit/contract";
import { describe, expect, it } from "vitest";
import { createFakeAdapter } from "./index.js";
import { ownText } from "./scenarios.js";

const cwd = mkdtempSync(join(tmpdir(), "ion-fake-"));
describeAdapterContract("fake", () => createFakeAdapter({ delayMs: 0 }), {
  hello: "hello",
  approve: "approve",
  slow: "slow",
  cwd,
});

async function turn(
  text: string,
  decision: "allow" | "deny" = "allow",
  more: { mcpUrl?: string; instructions?: string } = {},
) {
  const session = await createFakeAdapter({ delayMs: 0 }).start({
    cwd,
    model: null,
    effort: null,
    signal: new AbortController().signal,
    decide: async () => decision,
    ...(more.instructions ? { instructions: more.instructions } : {}),
    ...(more.mcpUrl ? { mcp: { name: "ion" as const, url: more.mcpUrl, headers: {} } } : {}),
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
  // Task review, 2026-11-19: ion's server gone mid-call (a test closing it) rejected the scenario's fetch with no
  // one to catch it: an unhandled ECONNRESET failed the whole test run. Now the turn ends, failed or answered.
  it("ends its turn when ion's server is gone, instead of throwing", async () => {
    const gone = "http://127.0.0.1:1/mcp";
    expect((await turn("asks", "allow", { mcpUrl: gone })).at(-1)).toBe("run.finished:failed");
    // An ion's turn whose tool can't reach ion: the step failed, the turn still ends.
    const ion = await turn("please check storefront", "allow", { mcpUrl: gone, instructions: "You are ion" });
    expect(ion.at(-1)).toMatch(/^run\.finished:/);
  });
});

// Tour, 2026-11-22: a fake ion's thread was briefed with its whole prompt, ion's memory index first, so the thread's
// title read "<ion-data id=… source="ion's memory index">".
describe("ownText", () => {
  it("is your message after the blocks ion put before it", () => {
    const index =
      '<ion-data id="ab12" source="ion\'s memory index">\nyou/a.md "A": "a"\n</ion-data id="ab12">\n\n';
    expect(ownText(`${index}please check storefront for the typo`)).toBe(
      "please check storefront for the typo",
    );
    expect(ownText("hello")).toBe("hello");
  });
});

// Plan 20 Task 5, 2026-11-23: the tour needs an agent paid per use (its line shows this week's cost); none of the real
// ones bills that way on the tour's computer. ION_FAKE_BILLING says how the fake bills.
describe("the fake's billing", () => {
  it("is what ION_FAKE_BILLING says, else none", async () => {
    expect((await createFakeAdapter().auth.status()).billing).toBeUndefined();
    process.env.ION_FAKE_BILLING = "api";
    try {
      expect((await createFakeAdapter().auth.status()).billing).toBe("api");
    } finally {
      delete process.env.ION_FAKE_BILLING;
    }
  });
});

// Plan 20 Task 5, 2026-11-23: the tour's ion chat that holds the only slot ran 30 s, so the chat queued behind it
// ("Waiting — 1 ion chat running") started before anyone could look. ION_FAKE_SLOW_S sets how long "slow" runs.
describe("the fake's slow", () => {
  it("runs as long as ION_FAKE_SLOW_S says", async () => {
    process.env.ION_FAKE_SLOW_S = "0.05";
    try {
      const t0 = Date.now();
      expect((await turn("slow")).at(-1)).toBe("run.finished:done");
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      delete process.env.ION_FAKE_SLOW_S;
    }
  });
});
