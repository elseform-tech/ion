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
const decide = (kind: string, input: Record<string, unknown>) => decideByPolicy(req(kind, input), { roots });

describe("decideByPolicy", () => {
  it("allows reads and searches inside the project, asks about them outside", () => {
    expect(decide("read", { file_path: join(project, "src/a.ts") })).toBe("allow");
    expect(decide("search", { pattern: "foo", path: project })).toBe("allow");
    expect(decide("read", { file_path: "/etc/passwd" })).toBe("ask");
  });

  it("allows edits inside the project and asks about the rest", () => {
    expect(decide("edit", { file_path: join(project, "new.ts") })).toBe("allow");
    expect(decide("edit", { file_path: join(outside, "x.ts") })).toBe("ask");
  });

  it("asks about an edit that names no path (fail closed)", () => {
    expect(decide("edit", {})).toBe("ask");
  });

  it("checks every path, including ACP locations", () => {
    expect(decide("edit", { locations: [join(project, "a.ts"), "/etc/hosts"] })).toBe("ask");
    expect(decide("edit", { locations: [join(project, "a.ts")] })).toBe("allow");
  });

  it("resolves symlinks before deciding", () => {
    expect(decide("edit", { file_path: join(project, "escape/x.ts") })).toBe("ask");
    expect(decide("read", { file_path: join(project, "escape/secret") })).toBe("ask");
  });

  it("asks about commands, web and everything else", () => {
    for (const kind of ["command", "web", "mcp", "other"])
      expect(decide(kind, { file_path: join(project, "a") })).toBe("ask");
  });

  it("fails closed for reads that name no path, and finds paths in any *path field", () => {
    expect(decide("read", {})).toBe("ask");
    expect(decide("edit", { filePath: "/etc/hosts" })).toBe("ask");
    expect(decide("edit", { target_path: join(project, "a.ts") })).toBe("allow");
  });

  it("fails closed for searches without a path, and checks ~ paths", () => {
    expect(decide("search", { pattern: "foo" })).toBe("ask");
    expect(decide("read", { file_path: "~/.ssh/id_rsa" })).toBe("ask");
    expect(decide("edit", { file_path: join(project, "a/../../x.ts") })).toBe("ask");
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

  // Regression (security review): git internals and agent/tool config can run code; always ask.
  it("asks about edits to git internals and agent config, even inside the worktree", () => {
    for (const f of [
      ".git",
      ".git/config",
      ".gitmodules",
      ".claude/settings.json",
      ".mcp.json",
      ".envrc",
      ".opencode/x.ts",
      "sub/.git/hooks/pre-commit",
    ])
      expect(decide("edit", { file_path: join(project, f) })).toBe("ask");
    expect(decide("read", { file_path: join(project, ".git/config") })).toBe("allow");
    expect(decide("edit", { file_path: join(project, "src/github.ts") })).toBe("allow");
  });

  it("checks declared path fields however deeply nested", () => {
    expect(decide("edit", { file_path: join(project, "a.ts"), edits: [{ file_path: "/etc/hosts" }] })).toBe(
      "ask",
    );
    expect(decide("edit", { locations: [join(project, "a.ts"), "/etc/hosts"] })).toBe("ask");
  });
});
