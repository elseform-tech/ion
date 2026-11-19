import { describe, expect, it } from "vitest";
import { diffLines, fileMark, treeOf } from "./diffLines.js";

describe("diffLines", () => {
  // Plan 08: the lab's .code: each line with its number and sign, numbered from the hunk header.
  it("numbers lines from the hunk header: old numbers for deletions, new ones for additions and context", () => {
    const patch =
      "diff --git a/t.ts b/t.ts\n--- a/t.ts\n+++ b/t.ts\n@@ -21,9 +21,14 @@ fn\n keep\n-old\n+new\n+more\n keep2\n";
    expect(diffLines(patch)).toEqual([
      { kind: "h", n: "", sign: "", text: "@@ -21,9 +21,14 @@ fn" },
      { kind: "ctx", n: "21", sign: "", text: "keep" },
      { kind: "del", n: "22", sign: "−", text: "old" },
      { kind: "add", n: "22", sign: "+", text: "new" },
      { kind: "add", n: "23", sign: "+", text: "more" },
      { kind: "ctx", n: "24", sign: "", text: "keep2" },
    ]);
  });

  // Security review: a changed line that looks like a header ("+++ x" is an added "++ x") is still shown.
  it("shows every line inside a hunk, even ones that look like file headers", () => {
    const patch =
      "diff --git a/t b/t\n--- a/t\n+++ b/t\n@@ -1,2 +1,2 @@\n--- gone\n+++ added\n+index x\n\\ No newline at end of file\n";
    expect(diffLines(patch).map((l) => [l.kind, l.n, l.text])).toEqual([
      ["h", "", "@@ -1,2 +1,2 @@"],
      ["del", "1", "-- gone"],
      ["add", "1", "++ added"],
      ["add", "2", "index x"],
      ["h", "", "\\ No newline at end of file"],
    ]);
  });

  it("marks a file added, deleted or modified from its patch", () => {
    expect(fileMark("diff --git a/x b/x\nnew file mode 100644\n")).toBe("A");
    expect(fileMark("diff --git a/x b/x\ndeleted file mode 100644\n")).toBe("D");
    expect(fileMark("diff --git a/x b/x\n@@ -1 +1 @@\n")).toBe("M");
    // Review, 2026-11-19: a patch can say it only by where the file goes.
    expect(fileMark("--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n")).toBe("D");
  });

  it("groups paths by folder for the tree, in order, files at the root last", () => {
    expect(treeOf(["src/cart/a.ts", "README.md", "src/cart/b.ts", "src/checkout/c.ts"])).toEqual([
      { folder: "src/cart", files: ["a.ts", "b.ts"] },
      { folder: "src/checkout", files: ["c.ts"] },
      { folder: "", files: ["README.md"] },
    ]);
  });
});
