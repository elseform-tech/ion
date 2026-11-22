import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openFile } from "./read-file.js";

// CodeQL on PR #25, 2026-11-22 (js/file-system-race): files were stat-ed by path, then read by path; what's read could
// be another file than the one checked. One open file is checked and read.
describe("openFile", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "ion-read-file-"));

  it("checks and reads one open file: its text and what it is", () => {
    const d = dir();
    writeFileSync(join(d, "a.md"), "hello");
    const f = openFile(join(d, "a.md"), 100);
    expect(f).toMatchObject({ kind: "file", text: "hello", size: 5 });
    expect(typeof f?.at).toBe("string");
  });

  it("gives no text for a folder or a file over the limit, and nothing for a missing one", () => {
    const d = dir();
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "big"), "x".repeat(20));
    expect(openFile(join(d, "sub"), 100)).toMatchObject({ kind: "dir", text: null });
    expect(openFile(join(d, "big"), 10)).toMatchObject({ kind: "file", text: null, size: 20 });
    expect(openFile(join(d, "none"), 10)).toBeNull();
  });
});
