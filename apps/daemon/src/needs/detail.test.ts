import { describe, expect, it } from "vitest";
import { needDetail } from "./detail.js";

describe("needDetail", () => {
  // Regression (security review): the action never hides behind a long input.
  it("shows the command, URL and paths in full first, and says when the rest is cut", () => {
    const d = needDetail({
      content: "x".repeat(5000),
      file_path: "/a/b.ts",
      command: `rm -rf ${"y".repeat(3000)}`,
    });
    expect(d.startsWith(`command: rm -rf ${"y".repeat(3000)}\nfile_path: /a/b.ts\n`)).toBe(true);
    expect(d).toMatch(/… \(\d+ more characters\)$/);
  });

  it("shows a short input whole", () => {
    expect(needDetail({ command: "pnpm test" })).toBe('command: pnpm test\n{"command":"pnpm test"}');
  });
});
