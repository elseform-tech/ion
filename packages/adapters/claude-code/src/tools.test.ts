import { describe, expect, it } from "vitest";
import { fileChange, toolSummary } from "./tools.js";

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
});
