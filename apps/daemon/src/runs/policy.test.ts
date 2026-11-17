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
    expect(decide("search", { pattern: "foo" })).toBe("allow");
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
});
