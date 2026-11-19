import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@ion/adapter-kit";
import { decideForIon } from "./gate.js";

// The user, 2026-11-19: ions require tools (reading, searching, running read-only commands) securely.
const ctx = { roots: ["/Users/me/proj"], home: "/Users/me", ionDirs: ["/Users/me/.ion"] };
const req = (r: Partial<ApprovalRequest>): ApprovalRequest => ({
  requestId: "r",
  toolId: "t",
  toolName: "Bash",
  kind: "command",
  summary: "",
  input: {},
  ...r,
});
const cmd = (command: string) => req({ kind: "command", input: { command } });

describe("an ion's gate", () => {
  it("an ion may read and search its project and run read-only chained commands", () => {
    expect(decideForIon(cmd("cat README.md && ls src"), ctx)).toBe("allow");
    expect(
      decideForIon(req({ toolName: "Read", kind: "read", input: { file_path: "/Users/me/proj/a.ts" } }), ctx),
    ).toBe("allow");
    expect(
      decideForIon(
        req({ toolName: "Grep", kind: "search", input: { pattern: "x", path: "/Users/me/proj/src" } }),
        ctx,
      ),
    ).toBe("allow");
  });

  it("an ion may never edit, write, install, push or reach outside", () => {
    const bad = [
      req({ toolName: "Write", kind: "edit", input: { file_path: "/Users/me/proj/a.ts", content: "x" } }),
      cmd("sed -i s/a/b/ a.ts"),
      cmd("npm install"),
      cmd("git push"),
      cmd("cat ~/.ssh/id_rsa"),
      req({ toolName: "Read", kind: "read", input: { file_path: "/etc/passwd" } }),
    ];
    for (const r of bad) expect(decideForIon(r, ctx)).toBe("deny");
  });

  it("an ion's own MCP tools are allowed and other MCP servers are denied", () => {
    const mcp = (toolName: string, mcpServer: string) => req({ kind: "mcp", toolName, mcpServer });
    expect(decideForIon(mcp("mcp__ion__projects", "ion"), ctx)).toBe("allow");
    expect(decideForIon(mcp("ion__start_thread", "ion"), ctx)).toBe("allow");
    expect(decideForIon(mcp("mcp__ion__chat_history", "ion"), ctx)).toBe("allow");
    expect(decideForIon(mcp("mcp__other__projects", "other"), ctx)).toBe("deny");
    expect(decideForIon(mcp("mcp__ion__projects", "other"), ctx)).toBe("deny");
    expect(decideForIon(mcp("mcp__ion__rm_rf", "ion"), ctx)).toBe("deny");
  });

  // Task review, 2026-11-19: `file -C` writes a .mgc file; ions never write.
  it("denies file -C", () => {
    expect(decideForIon(cmd("file -C -m x"), ctx)).toBe("deny");
  });

  // Task review, 2026-11-19: `ask` and `report_outcome` are run tools; an ion has no run to ask or report in.
  it("denies run-only tools to an ion", () => {
    for (const t of ["ask", "report_outcome"])
      expect(decideForIon(req({ kind: "mcp", toolName: `mcp__ion__${t}`, mcpServer: "ion" }), ctx)).toBe(
        "deny",
      );
  });

  // Task review, 2026-11-19: a third-party tool arriving as kind "other" (opencode's foo_bar) is denied.
  it("denies a third-party tool of kind other", () => {
    expect(decideForIon(req({ kind: "other", toolName: "foo_bar" }), ctx)).toBe("deny");
  });
});
