import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeAdapterContract } from "@ion/adapter-kit/contract";
import { describe, expect, it } from "vitest";
import { type AcpHarness, createAcpAdapter } from "./index.js";

const AGENT = fileURLToPath(new URL("../test/fake-agent.mjs", import.meta.url));
const fake: AcpHarness = {
  id: "fake-acp",
  label: "Fake ACP",
  bin: process.execPath,
  args: [AGENT],
  versionArgs: ["--version"],
  loginArgs: [],
  loginHint: "fake login",
  defaultModel: null,
};
const cwd = mkdtempSync(join(tmpdir(), "ion-acp-"));
const make = () => createAcpAdapter(fake, { which: () => process.execPath });

describeAdapterContract("acp", make, { hello: "hello", approve: "approve", slow: "slow", cwd });

describe("acp adapter", () => {
  it("probes sign-in without sending a prompt", async () => {
    expect(await make().auth.status()).toEqual({ signedIn: true, method: "Signed in" });
    process.env.FAKE_ACP_SIGNED_OUT = "1";
    try {
      expect(await make().auth.status()).toEqual({ signedIn: false, method: "Not signed in" });
      await expect(
        make().start({
          cwd,
          model: null,
          effort: null,
          signal: new AbortController().signal,
          decide: async () => "allow",
        }),
      ).rejects.toThrow("Fake ACP isn't signed in. Run: fake login");
    } finally {
      delete process.env.FAKE_ACP_SIGNED_OUT;
    }
  });

  it("streams text in batches and reports the model and cost", async () => {
    const s = await make().start({
      cwd,
      model: null,
      effort: null,
      signal: new AbortController().signal,
      decide: async () => "allow",
    });
    await s.send({ text: "hello" });
    const events = [];
    for await (const e of s.events()) events.push(e);
    expect(events[0]).toMatchObject({ type: "run.started", data: { harness: "fake-acp", model: "fake-1" } });
    expect(
      events
        .filter((e) => e.type === "message.delta")
        .map((e) => (e.data as { text: string }).text)
        .join(""),
    ).toBe("Hi there");
    expect(events.find((e) => e.type === "usage.reported")?.data).toMatchObject({ costUsd: 0.002 });
    expect(events.at(-1)).toEqual({ type: "run.finished", data: { status: "done" } });
  });

  it("reports not installed when the binary is missing", async () => {
    expect(await createAcpAdapter(fake, { which: () => null }).detect()).toEqual({ installed: false });
  });

  it("never widens a decision: allow without an allow_once option is refused", async () => {
    const { answerPermission } = await import("./session.js");
    const opts = (kinds: string[]) => ({
      toolCall: { toolCallId: "t" },
      options: kinds.map((k) => ({ optionId: k, kind: k })),
    });
    const emit = () => {};
    expect(await answerPermission(opts(["allow_always", "reject_once"]), async () => "allow", emit)).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(
      await answerPermission(opts(["allow_once", "allow_always"]), async () => "allow_always", emit),
    ).toEqual({
      outcome: { outcome: "selected", optionId: "allow_always" },
    });
    expect(await answerPermission(opts(["allow_once"]), async () => "allow_always", emit)).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(await answerPermission(opts(["reject_always", "allow_once"]), async () => "deny", emit)).toEqual({
      outcome: { outcome: "selected", optionId: "reject_always" },
    });
  });
});
