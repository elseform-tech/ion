import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterEvent, StartOpts } from "@ion/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { closeWarm } from "./bare.js";
import { type AcpHarness, createAcpAdapter } from "./index.js";

const AGENT = fileURLToPath(new URL("../test/fake-agent.mjs", import.meta.url));
const judge: AcpHarness = {
  id: "fake-bare",
  label: "Fake ACP",
  bin: process.execPath,
  args: [AGENT],
  versionArgs: ["--version"],
  loginArgs: [],
  loginHint: "fake login",
  defaultModel: null,
  bare: { model: "fake-2", effort: "low", args: () => [AGENT, "--bare-profile"] },
  forgetArgs: (id) => [AGENT, "--forget", id],
};

type Row = { cwd?: string; pid?: number; args?: string[]; gate?: string | null; closed?: string; forgot?: string };
const rows = (log: string): Row[] =>
  readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Row);

async function verdict(h: AcpHarness, cwd: string, extra: Partial<StartOpts> = {}): Promise<AdapterEvent[]> {
  const s = await createAcpAdapter(h, { which: () => process.execPath }).start({
    cwd,
    model: null,
    effort: null,
    bare: true,
    signal: new AbortController().signal,
    decide: async () => "deny",
    ...extra,
  });
  await s.send({ text: "hello" });
  const out: AdapterEvent[] = [];
  for await (const e of s.events()) out.push(e);
  await s.close();
  return out;
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
};

afterEach(() => {
  closeWarm();
  delete process.env.FAKE_ACP_RECORD;
});

// Final review, 2026-11-22 (live: Grok's judge timed out in every live chat, up to 44 s): each verdict spawned the
// agent and started its server, with its tools on. A bare start now keeps one warm agent per harness (and folder),
// opens a fresh session per verdict and closes it (and has the agent forget it, so judge sessions don't pile up in
// your history), runs with no tools (the harness's bare arguments; ion's gate pointed at an address that refuses
// every call), and picks the harness's fast model and low effort.
describe("a bare start (ion's judge) on an ACP agent", () => {
  it("reuses one warm agent, a fresh session per verdict, closed and forgotten after", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ion-bare-")));
    const log = join(cwd, "log");
    process.env.FAKE_ACP_RECORD = log;
    await verdict(judge, cwd);
    await verdict(judge, cwd);
    await until(() => rows(log).filter((r) => r.forgot).length === 2);
    const opened = rows(log).filter((r) => r.cwd);
    expect(opened).toHaveLength(2);
    expect(opened[0]!.pid).toBe(opened[1]!.pid);
    expect(rows(log).filter((r) => r.closed).map((r) => r.closed).sort()).toEqual(["s1", "s2"]);
    expect(rows(log).filter((r) => r.forgot).map((r) => r.forgot).sort()).toEqual(["s1", "s2"]);
  });

  it("starts with the harness's bare arguments, every tool refused, on its fast model", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ion-bare-")));
    const log = join(cwd, "log");
    process.env.FAKE_ACP_RECORD = log;
    const events = await verdict(judge, cwd);
    const [r] = rows(log);
    expect(r?.args).toEqual(["--bare-profile"]);
    expect(r?.gate).toMatch(/^http:\/\/127\.0\.0\.1:0\//);
    const started = events.find((e) => e.type === "run.started")?.data as { model: string; effort: string };
    expect(started.model).toBe("fake-2");
    expect(started.effort).toBe("low");
  });

  it("a chat's run still gets its own agent process", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ion-bare-")));
    const log = join(cwd, "log");
    process.env.FAKE_ACP_RECORD = log;
    await verdict(judge, cwd, { bare: false });
    await verdict(judge, cwd, { bare: false });
    const opened = rows(log).filter((r) => r.cwd);
    expect(opened[0]!.pid).not.toBe(opened[1]!.pid);
    expect(opened[0]!.args).toEqual([]);
  });
});
