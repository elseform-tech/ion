import type { ApprovalRequest } from "@ion/adapter-kit";
import { describe, expect, it } from "vitest";
import { dreamVerdict } from "./dream.js";

// The user, 2026-11-22: ion's dream tidies memory overnight "within strict limits": its agent may call ion's memory
// tools, and nothing else (no files, commands, web, or other servers).
const req = (o: Partial<ApprovalRequest>): ApprovalRequest =>
  ({
    requestId: "r",
    toolId: "t",
    toolName: "",
    kind: "other",
    summary: "",
    input: {},
    ...o,
  }) as ApprovalRequest;

describe("the dream's gate", () => {
  it("lets the dream use memory's tools only", () => {
    for (const toolName of ["ion__memory_write", "mcp__ion__memory_forget", "ion__memory_index"])
      expect(dreamVerdict(req({ kind: "mcp", mcpServer: "ion", toolName })).decision).toBe("allow");
    // Live, Grok, 2026-11-22: Grok finds ion's tools with its own search_tool first; refused, it found none.
    expect(dreamVerdict(req({ kind: "search", toolName: "search_tool" })).decision).toBe("allow");
    const denied = [
      req({ kind: "mcp", mcpServer: "ion", toolName: "ion__start_thread" }),
      req({ kind: "mcp", mcpServer: "ion", toolName: "ion__search_chats" }),
      req({ kind: "mcp", mcpServer: "other", toolName: "ion__memory_write" }),
      req({ kind: "read", toolName: "Read", input: { file_path: "/etc/hosts" } }),
      req({ kind: "web", toolName: "WebSearch" }),
      req({ kind: "execute", toolName: "Bash", input: { command: "ls" } }),
    ];
    for (const r of denied) expect(dreamVerdict(r).decision).toBe("deny");
  });
});
