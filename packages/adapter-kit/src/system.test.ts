import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVersion, projectRoots, whichOnPath } from "./system.js";

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
});
