import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSmallFile } from "./read-small.js";

// CodeQL on main, 2026-11-22 (js/file-system-race): config files were checked by path and read by path.
describe("readSmallFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "ion-small-"));

  it("reads a small file, and one through a link", () => {
    writeFileSync(join(dir, "a.json"), "{}");
    symlinkSync(join(dir, "a.json"), join(dir, "link.json"));
    expect(readSmallFile(join(dir, "a.json"), 10)).toBe("{}");
    expect(readSmallFile(join(dir, "link.json"), 10)).toBe("{}");
  });

  it("is null for a missing file, a folder or one too big", () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "big"), "x".repeat(11));
    expect(readSmallFile(join(dir, "none"), 10)).toBeNull();
    expect(readSmallFile(join(dir, "sub"), 10)).toBeNull();
    expect(readSmallFile(join(dir, "big"), 10)).toBeNull();
  });

  it("doesn't hang on a pipe", () => {
    execFileSync("mkfifo", [join(dir, "fifo")]);
    expect(readSmallFile(join(dir, "fifo"), 10)).toBeNull();
  });
});
