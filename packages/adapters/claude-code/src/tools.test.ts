import { describe, expect, it } from "vitest";
import { fileChange, mcpServerOf, toolSummary } from "./tools.js";

// Regression: macOS /var is a symlink to /private/var; Claude reports real paths.
describe("tool paths", () => {
  const roots = ["/var/x", "/private/var/x"];
  it("shortens paths under either the folder as given or its real location", () => {
    expect(toolSummary("Read", { file_path: "/private/var/x/src/a.ts" }, roots)).toBe("src/a.ts");
    expect(toolSummary("Read", { file_path: "/var/x/b.ts" }, roots)).toBe("b.ts");
    expect(fileChange("Write", { file_path: "/private/var/x/notes.md", content: "hi" }, roots)?.path).toBe(
      "notes.md",
    );
  });
  it("keeps paths outside the project absolute", () => {
    expect(toolSummary("Read", { file_path: "/etc/hosts" }, roots)).toBe("/etc/hosts");
  });

  it("collapses newlines and marks cut-off text in one-line summaries", () => {
    const long = `echo ${"x".repeat(100)}\nrm -rf build`;
    const short = toolSummary("Bash", { command: long }, roots);
    expect(short.endsWith("…")).toBe(true);
    expect(short).not.toContain("\n");
    expect(toolSummary("Bash", { command: long }, roots, { full: true })).toBe(
      `echo ${"x".repeat(100)} ⏎ rm -rf build`,
    );
  });

  it("names the MCP server a tool belongs to", () => {
    expect(mcpServerOf("mcp__ion__chat_history")).toBe("ion");
    expect(mcpServerOf("mcp__git_hub__x")).toBe("git_hub");
    expect(mcpServerOf("Bash")).toBeNull();
  });
});
