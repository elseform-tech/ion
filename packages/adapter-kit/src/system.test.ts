import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVersion, projectRoots, whichAgent, whichOnPath } from "./system.js";

describe("system helpers", () => {
  it("finds an executable on PATH and ignores missing ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "ion-bin-"));
    writeFileSync(join(dir, "tool"), "#!/bin/sh\n");
    chmodSync(join(dir, "tool"), 0o755);
    expect(whichOnPath("tool", { PATH: `/nope:${dir}` })).toBe(join(dir, "tool"));
    expect(whichOnPath("missing", { PATH: dir })).toBeNull();
  });

  it("reads a version number from --version output", () => {
    expect(parseVersion("2.1.326 (Claude Code)")).toBe("2.1.326");
    expect(parseVersion("grok 1.0.77 (50ca579) [stable]")).toBe("1.0.77");
    expect(parseVersion("no version")).toBeNull();
  });

  it("returns the folder and its real path when they differ", () => {
    const base = mkdtempSync(join(tmpdir(), "ion-roots-"));
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "link"));
    const roots = projectRoots(join(base, "link"));
    expect(roots[0]).toBe(join(base, "link"));
    expect(roots.at(-1)?.endsWith("/real")).toBe(true);
  });

  // 2026-11-28: `pnpm check` started your real claude, grok and opencode (their sign-in and model checks: `claude auth
  // status`, `opencode acp`, `grok agent stdio`). Tests point ION_AGENTS_PATH at a folder of their own; agents are
  // looked up only there.
  it("looks for an agent only in ION_AGENTS_PATH under tests and the tour, on PATH otherwise", () => {
    const real = mkdtempSync(join(tmpdir(), "ion-bin-"));
    writeFileSync(join(real, "opencode"), "#!/bin/sh\n");
    chmodSync(join(real, "opencode"), 0o755);
    const none = mkdtempSync(join(tmpdir(), "ion-bin-"));
    expect(whichAgent("opencode", { PATH: real, VITEST: "true", ION_AGENTS_PATH: none })).toBeNull();
    expect(whichAgent("opencode", { PATH: real, ION_TOUR: "1", ION_AGENTS_PATH: none })).toBeNull();
    expect(whichAgent("opencode", { PATH: none, VITEST: "true", ION_AGENTS_PATH: real })).toBe(
      join(real, "opencode"),
    );
    // Your ion never honours it.
    expect(whichAgent("opencode", { PATH: real, ION_AGENTS_PATH: none })).toBe(join(real, "opencode"));
  });
});
