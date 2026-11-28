import { describe, expect, it } from "vitest";
import { projectName, projectsFile } from "./projectName.js";

// Review of Plan 21 Task 4 (2026-11-28): Tools' "From default's .mcp.json" still showed ion's folder by its id.
describe("a project's name as shown", () => {
  it("names default No project, and its file plainly", () => {
    expect(projectName("default")).toBe("No project");
    expect(projectName("shop", "Shop")).toBe("Shop");
    expect(projectsFile("shop", ".mcp.json")).toBe("shop's .mcp.json");
    expect(projectsFile("default", ".mcp.json")).toBe(".mcp.json in No project");
  });
});
