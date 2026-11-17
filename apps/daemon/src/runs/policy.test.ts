import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest } from "@ion/adapter-kit";
import { describe, expect, it } from "vitest";
import { decideByPolicy } from "./policy.js";

const project = realpathSync(mkdtempSync(join(tmpdir(), "ion-policy-")));
mkdirSync(join(project, "src"));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "ion-outside-")));
symlinkSync(outside, join(project, "escape"));
const roots = [project];

const req = (kind: string, input: Record<string, unknown>): ApprovalRequest => ({
  requestId: "q",
  toolId: "t",
  toolName: "x",
  kind,
  summary: "s",
  input,
});
const decide = (kind: string, input: Record<string, unknown>, allowEdits = true) =>
  decideByPolicy(req(kind, input), { allowEdits, roots });

describe("decideByPolicy", () => {
  it("allows reads and searches inside the project, denies them outside", () => {
    expect(decide("read", { file_path: join(project, "src/a.ts") })).toBe("allow");
    expect(decide("search", { pattern: "foo", path: project })).toBe("allow");
    expect(decide("read", { file_path: "/etc/passwd" })).toBe("deny");
  });

  it("allows edits only with allowEdits and only inside the project", () => {
    expect(decide("edit", { file_path: join(project, "new.ts") })).toBe("allow");
    expect(decide("edit", { file_path: join(project, "new.ts") }, false)).toBe("deny");
    expect(decide("edit", { file_path: join(outside, "x.ts") })).toBe("deny");
  });

  it("denies an edit that names no path (fail closed)", () => {
    expect(decide("edit", {})).toBe("deny");
  });

  it("checks every path, including ACP locations", () => {
    expect(decide("edit", { locations: [join(project, "a.ts"), "/etc/hosts"] })).toBe("deny");
    expect(decide("edit", { locations: [join(project, "a.ts")] })).toBe("allow");
  });

  it("resolves symlinks before deciding", () => {
    expect(decide("edit", { file_path: join(project, "escape/x.ts") })).toBe("deny");
    expect(decide("read", { file_path: join(project, "escape/secret") })).toBe("deny");
  });

  it("denies commands, web and everything else", () => {
    for (const kind of ["command", "web", "mcp", "other"])
      expect(decide(kind, { file_path: join(project, "a") })).toBe("deny");
  });

  it("fails closed for reads that name no path, and finds paths in any *path field", () => {
    expect(decide("read", {})).toBe("deny");
    expect(decide("edit", { filePath: "/etc/hosts" })).toBe("deny");
    expect(decide("edit", { target_path: join(project, "a.ts") })).toBe("allow");
  });

  it("fails closed for searches without a path, and checks ~ paths", () => {
    expect(decide("search", { pattern: "foo" })).toBe("deny");
    expect(decide("read", { file_path: "~/.ssh/id_rsa" })).toBe("deny");
    expect(decide("edit", { file_path: join(project, "a/../../x.ts") })).toBe("deny");
  });

  // Regression (final review I1): file content and patterns aren't paths.
  it("allows ordinary edits and searches whose content looks like a path", () => {
    expect(decide("edit", { file_path: join(project, "a.ts"), content: "// header\nexport {};" })).toBe(
      "allow",
    );
    expect(
      decide("edit", { file_path: join(project, "a.ts"), old_string: "// TODO", new_string: "// done" }),
    ).toBe("allow");
    expect(decide("search", { pattern: "/api/users", path: project })).toBe("allow");
  });

  it("checks declared path fields however deeply nested", () => {
    expect(decide("edit", { file_path: join(project, "a.ts"), edits: [{ file_path: "/etc/hosts" }] })).toBe(
      "deny",
    );
    expect(decide("edit", { locations: [join(project, "a.ts"), "/etc/hosts"] })).toBe("deny");
  });
});
