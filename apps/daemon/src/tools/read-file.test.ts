import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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

  // Automated review of 9777e0b, 2026-11-22: a FIFO planted at a settings path blocked the daemon's open; a link was
  // followed wherever it pointed. A FIFO is opened without blocking and isn't read; a link only where the caller says.
  it("doesn't block on a FIFO, and follows a link only when asked", () => {
    const d = dir();
    execFileSync("mkfifo", [join(d, "pipe")]);
    expect(openFile(join(d, "pipe"), 100)).toMatchObject({ kind: "other", text: null });
    writeFileSync(join(d, "real.json"), "{}");
    symlinkSync(join(d, "real.json"), join(d, "link.json"));
    expect(openFile(join(d, "link.json"), 100)).toBeNull();
    const follow = { root: d };
    expect(openFile(join(d, "link.json"), 100, undefined, { follow })).toMatchObject({
      kind: "file",
      text: "{}",
    });
    // Automated review of d407c95, 2026-11-22: one hop, only into its root, never into a folder it denies.
    const out = dir();
    writeFileSync(join(out, "secret"), "s");
    symlinkSync(join(out, "secret"), join(d, "out.json"));
    expect(openFile(join(d, "out.json"), 100, undefined, { follow })).toBeNull();
    mkdirSync(join(d, ".ssh"));
    writeFileSync(join(d, ".ssh", "id"), "k");
    symlinkSync(join(d, ".ssh", "id"), join(d, "id.json"));
    const denied = { follow: { root: d, deny: [join(d, ".ssh")] } };
    expect(openFile(join(d, "id.json"), 100, undefined, denied)).toBeNull();
    symlinkSync(join(d, "link.json"), join(d, "two.json"));
    expect(openFile(join(d, "two.json"), 100, undefined, { follow })).toBeNull();
  }, 10_000);
});
