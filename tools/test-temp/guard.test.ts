import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realAgent, takeRefused } from "./guard.js";
import { tempRun } from "./setup.js";

// 2026-11-28: `pnpm check` started the real claude, grok and opencode (their sign-in and model checks). Every test
// worker refuses to start one, and fails the test that tried.
describe("starting a real agent in a test", () => {
  let end: () => void;
  const made: string[] = [];
  const tmp = (prefix: string) => {
    made.push(mkdtempSync(join("/tmp", prefix)));
    return made.at(-1)!;
  };
  beforeEach(() => {
    end = tempRun({ base: tmp("tt-guard-") });
  });
  afterEach(() => {
    end();
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // Stand-ins for your installed agents, outside the run's folder (as /opt/homebrew/bin is).
  const outside = () => {
    const dir = tmp("tt-guard-bin-");
    for (const n of ["claude", "grok", "codex", "opencode"]) {
      writeFileSync(join(dir, n), "#!/bin/sh\n");
      chmodSync(join(dir, n), 0o755);
    }
    return dir;
  };

  it("is refused for your agents, from anywhere outside the run's folder", () => {
    const dir = outside();
    expect(realAgent(join(dir, "claude"))).toMatch(/real claude/);
    expect(realAgent(join(dir, "grok"))).toMatch(/real grok/);
    expect(realAgent("codex", { PATH: `/nope:${dir}` })).toMatch(/real codex/);
    expect(realAgent("/usr/bin/git")).toBeNull();
    // Nothing there, nothing starts (a test's made-up path).
    expect(realAgent("/nonexistent/codex")).toBeNull();
  });

  it("allows a stand-in the test made, and a live eval", () => {
    expect(realAgent(join(process.env.TMPDIR!, "bin", "opencode"))).toBeNull();
    process.env.ION_LIVE = "1";
    try {
      expect(realAgent(join(outside(), "opencode"))).toBeNull();
    } finally {
      delete process.env.ION_LIVE;
    }
  });

  it("throws before it starts, through spawn and execFile, and the test is told", async () => {
    const dir = outside();
    expect(() => spawn(join(dir, "opencode"), ["acp"])).toThrow(/real opencode/);
    expect(() => execFile(join(dir, "claude"), ["auth", "status"])).toThrow(/real claude/);
    expect(takeRefused()).toHaveLength(2);
    const bin = mkdtempSync(join(process.env.TMPDIR!, "bin-"));
    writeFileSync(join(bin, "grok"), "#!/bin/sh\necho ok\n");
    chmodSync(join(bin, "grok"), 0o755);
    const out = await new Promise<string>((r) => execFile(join(bin, "grok"), (_e, o) => r(String(o))));
    expect(out.trim()).toBe("ok");
  });
});
